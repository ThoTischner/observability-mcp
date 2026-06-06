// Upstream MCP federation client.
//
// One UpstreamClient per remote MCP gateway. On connect() it runs the
// MCP initialize handshake, fetches tools/list, and caches the catalog
// locally. callTool() forwards a request to the upstream and returns
// its CallToolResult verbatim.
//
// Transports:
//   - "http"  — Streamable HTTP to an upstream gateway URL (default).
//   - "stdio" — spawn a child process that speaks MCP over its stdio
//               channels. The classic MCP transport, useful when the
//               upstream is a CLI-style server (omcp inspector-config,
//               a local-only MCP, an in-cluster sidecar).
//   - "ws"    — WebSocket to a ws:// or wss:// URL. Useful when the
//               upstream gateway exposes MCP via the WS subprotocol
//               rather than streamable HTTP. No bearer-auth header
//               (the SDK transport only accepts a URL); operators
//               that need auth append it as a query string or run
//               the gateway behind an authenticating reverse proxy.
//
// Auth forwarding modes:
//   - "none" — no auth header on outbound calls
//   - "bearer" — static OMCP_FEDERATION_TOKEN_<NAME> sent as Bearer
//                (HTTP transport only — stdio doesn't have HTTP headers)
//
// OIDC + UAID passthrough are deferred — they require a per-request
// identity hand-off the federation manager doesn't carry today.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";

interface UpstreamCommonConfig {
  /** Stable source name (used in the namespace prefix + audit entries). */
  name: string;
  /** Tool-name prefix; default = source name. Resulting registered
   *  tool name is `<prefix>.<upstream-tool-name>`. */
  namespacePrefix?: string;
  /** ms between automatic catalog refreshes. Default 5 minutes;
   *  0 disables auto-refresh (manual refresh() only). */
  refreshIntervalMs?: number;
  /** Test-only: inject a pre-built MCP Transport instance.
   *  Skips the spawn / fetch path entirely. */
  _transport?: unknown;
}

export interface UpstreamHttpConfig extends UpstreamCommonConfig {
  transport?: "http";
  /** Upstream Streamable HTTP URL (must end at /mcp). */
  url: string;
  /** Static bearer token sent on every outbound call. */
  bearerToken?: string;
}

export interface UpstreamStdioConfig extends UpstreamCommonConfig {
  transport: "stdio";
  /** Executable to spawn (e.g. "npx", "node", "/usr/local/bin/mcp"). */
  command: string;
  /** Argv for the executable. */
  args?: string[];
  /** Extra env merged into the child process's environment. */
  env?: Record<string, string>;
}

export interface UpstreamWebsocketConfig extends UpstreamCommonConfig {
  transport: "ws";
  /** Upstream WebSocket URL — `ws://` or `wss://`. */
  url: string;
}

export type UpstreamConfig =
  | UpstreamHttpConfig
  | UpstreamStdioConfig
  | UpstreamWebsocketConfig;

export interface UpstreamToolInfo {
  /** Local namespaced name: `<prefix>.<upstreamName>`. */
  namespacedName: string;
  /** Original name on the upstream. */
  upstreamName: string;
  /** Upstream source name (audit attribution + diagnostics). */
  sourceName: string;
  /** Tool description as the upstream advertises it. */
  description: string;
  /** Upstream's inputSchema, forwarded verbatim. */
  inputSchema: unknown;
}

export type UpstreamStatus = "connecting" | "ready" | "degraded" | "disconnected";

export class UpstreamClient {
  readonly name: string;
  /** Empty-string for stdio (no remote URL); kept on the public surface
   *  so the UI doesn't have to special-case the transport kind. */
  readonly url: string;
  readonly namespacePrefix: string;
  readonly transportKind: "http" | "stdio" | "ws";
  private cfg: UpstreamConfig;
  private client?: Client;
  // `unknown` because the SDK exposes a different concrete type per
  // transport. Federation only talks to the transport via the SDK
  // Client object, so the concrete type isn't needed here.
  private transport?: unknown;
  private toolsCache: UpstreamToolInfo[] = [];
  private status: UpstreamStatus = "disconnected";
  private lastError?: string;
  private refreshTimer?: NodeJS.Timeout;
  private refreshIntervalMs: number;

  constructor(cfg: UpstreamConfig) {
    this.cfg = cfg;
    this.name = cfg.name;
    this.transportKind =
      cfg.transport === "stdio" ? "stdio" :
      cfg.transport === "ws" ? "ws" :
      "http";
    this.url =
      this.transportKind === "stdio" ? `stdio:${(cfg as UpstreamStdioConfig).command}` :
      this.transportKind === "ws" ? (cfg as UpstreamWebsocketConfig).url :
      (cfg as UpstreamHttpConfig).url;
    this.namespacePrefix = cfg.namespacePrefix ?? cfg.name;
    this.refreshIntervalMs = cfg.refreshIntervalMs ?? 5 * 60 * 1000;
  }

  getStatus(): { status: UpstreamStatus; lastError?: string; toolCount: number } {
    return { status: this.status, lastError: this.lastError, toolCount: this.toolsCache.length };
  }

  /** Cached catalog (read-only). */
  getTools(): UpstreamToolInfo[] {
    return [...this.toolsCache];
  }

  /** Connect + initial catalog fetch. Logs failures and leaves the
   *  client in `degraded` so the catalog stays empty rather than
   *  blocking startup. Re-runnable. */
  async connect(): Promise<void> {
    this.status = "connecting";
    try {
      this.transport = this.buildTransport();
      this.client = new Client(
        { name: "observability-mcp-federation", version: "1" },
        { capabilities: {} },
      );
      // SDK Client.connect accepts any Transport implementation; the
      // injected test transport just needs the start()/send()/close()
      // contract — the type assertion sidesteps each concrete class.
      await this.client.connect(this.transport as Parameters<Client["connect"]>[0]);
      await this.refresh();
      this.status = "ready";
      this.lastError = undefined;
      if (this.refreshIntervalMs > 0) {
        this.refreshTimer = setInterval(() => {
          this.refresh().catch((err: unknown) => {
            console.warn(
              "UpstreamClient %s: background refresh failed: %s",
              this.name,
              err instanceof Error ? err.message : String(err),
            );
          });
        }, this.refreshIntervalMs).unref?.();
      }
    } catch (err) {
      this.status = "degraded";
      this.lastError = err instanceof Error ? err.message : String(err);
      console.warn(
        "UpstreamClient %s: connect failed (%s). Federation continues without this upstream.",
        this.name,
        this.lastError,
      );
    }
  }

  /** Re-fetch the upstream tool catalog. Throws on failure so the
   *  caller can choose to degrade or retry. */
  async refresh(): Promise<void> {
    if (!this.client) throw new Error(`upstream ${this.name} not connected`);
    const result = await this.client.listTools({});
    this.toolsCache = (result.tools ?? []).map((t) => ({
      namespacedName: `${this.namespacePrefix}.${t.name}`,
      upstreamName: t.name,
      sourceName: this.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
    }));
  }

  /** Forward a callTool request to the upstream by upstream-tool name
   *  (NOT the namespaced name — the registry strips the prefix before
   *  calling here). */
  async callTool(upstreamName: string, args: unknown): Promise<unknown> {
    if (!this.client) {
      throw new Error(`upstream ${this.name} is ${this.status}`);
    }
    return this.client.callTool({
      name: upstreamName,
      arguments: (args ?? {}) as Record<string, unknown>,
    });
  }

  async close(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    try {
      await this.client?.close();
    } catch {
      /* socket may already be down */
    }
    this.status = "disconnected";
  }

  // --- internals ----------------------------------------------------

  private buildTransport(): unknown {
    // Test path: a pre-built transport short-circuits the spawn / fetch.
    if (this.cfg._transport) return this.cfg._transport;

    if (this.transportKind === "stdio") {
      const cfg = this.cfg as UpstreamStdioConfig;
      return new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: cfg.env,
      });
    }

    if (this.transportKind === "ws") {
      const cfg = this.cfg as UpstreamWebsocketConfig;
      return new WebSocketClientTransport(new URL(cfg.url));
    }

    const cfg = this.cfg as UpstreamHttpConfig;
    const url = new URL(cfg.url);
    const init: RequestInit = { headers: {} as Record<string, string> };
    if (cfg.bearerToken) {
      (init.headers as Record<string, string>)["Authorization"] = `Bearer ${cfg.bearerToken}`;
    }
    return new StreamableHTTPClientTransport(url, { requestInit: init });
  }
}
