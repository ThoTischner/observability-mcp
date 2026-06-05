// Upstream MCP federation client.
//
// One UpstreamClient per remote MCP gateway. On connect() it runs the
// MCP initialize handshake, fetches tools/list, and caches the catalog
// locally. callTool() forwards a request to the upstream and returns
// its CallToolResult verbatim.
//
// Transport: Streamable HTTP only in this slice. Stdio + WebSocket
// upstreams are deferred (the SDK already provides client transports
// for both; wiring them is mechanical once the routing logic settles).
//
// Auth forwarding modes:
//   - "none" — no auth header on outbound calls
//   - "bearer" — static OMCP_FEDERATION_TOKEN_<NAME> sent as Bearer
//
// OIDC + UAID passthrough are deferred — they require a per-request
// identity hand-off the federation manager doesn't carry today.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface UpstreamConfig {
  /** Stable source name (used in the namespace prefix + audit entries). */
  name: string;
  /** Upstream Streamable HTTP URL (must end at /mcp). */
  url: string;
  /** Static bearer token sent on every outbound call. */
  bearerToken?: string;
  /** Tool-name prefix; default = source name. Resulting registered
   *  tool name is `<prefix>.<upstream-tool-name>`. */
  namespacePrefix?: string;
  /** ms between automatic catalog refreshes. Default 5 minutes;
   *  0 disables auto-refresh (manual refresh() only). */
  refreshIntervalMs?: number;
}

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
  readonly url: string;
  readonly namespacePrefix: string;
  private bearerToken?: string;
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private toolsCache: UpstreamToolInfo[] = [];
  private status: UpstreamStatus = "disconnected";
  private lastError?: string;
  private refreshTimer?: NodeJS.Timeout;
  private refreshIntervalMs: number;

  constructor(cfg: UpstreamConfig) {
    this.name = cfg.name;
    this.url = cfg.url;
    this.namespacePrefix = cfg.namespacePrefix ?? cfg.name;
    this.bearerToken = cfg.bearerToken;
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
      const url = new URL(this.url);
      const init: RequestInit = { headers: {} as Record<string, string> };
      if (this.bearerToken) {
        (init.headers as Record<string, string>)["Authorization"] = `Bearer ${this.bearerToken}`;
      }
      this.transport = new StreamableHTTPClientTransport(url, { requestInit: init });
      this.client = new Client(
        { name: "observability-mcp-federation", version: "1" },
        { capabilities: {} },
      );
      await this.client.connect(this.transport);
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
}
