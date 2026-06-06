// FederationRegistry — collects every UpstreamClient + exposes a
// flat view of namespaced tools across them. createMcpServer reads
// `getNamespacedTools()` on each per-session instantiation and
// registers a proxy handler for each one that calls
// `callNamespacedTool()`.

import type { UpstreamClient, UpstreamToolInfo } from "./upstream.js";

export class FederationRegistry {
  private upstreams = new Map<string, UpstreamClient>();

  add(client: UpstreamClient): void {
    if (this.upstreams.has(client.name)) {
      throw new Error(`federation upstream ${client.name} already registered`);
    }
    this.upstreams.set(client.name, client);
  }

  remove(name: string): void {
    this.upstreams.delete(name);
  }

  get(name: string): UpstreamClient | undefined {
    return this.upstreams.get(name);
  }

  list(): UpstreamClient[] {
    return [...this.upstreams.values()];
  }

  /** Flat, namespaced tool view across every connected upstream. */
  getNamespacedTools(): UpstreamToolInfo[] {
    const out: UpstreamToolInfo[] = [];
    for (const client of this.upstreams.values()) {
      out.push(...client.getTools());
    }
    return out;
  }

  /** Dispatch a namespaced tool call to the right upstream. The
   *  namespaced name MUST exist in the catalog; the caller (the
   *  registerTool wrapper in createMcpServer) is responsible for not
   *  routing tools that aren't there. */
  async callNamespacedTool(namespacedName: string, args: unknown): Promise<unknown> {
    for (const client of this.upstreams.values()) {
      const match = client.getTools().find((t) => t.namespacedName === namespacedName);
      if (match) return client.callTool(match.upstreamName, args);
    }
    throw new Error(`federated tool not found: ${namespacedName}`);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.upstreams.values()].map((c) => c.close()));
    this.upstreams.clear();
  }
}

/**
 * Parse the OMCP_FEDERATION_UPSTREAMS env into a list of upstream
 * configs. Shape:
 *
 *   "a=https://gw.a/mcp,b=stdio:/usr/bin/mcp arg1,c=wss://gw.c/mcp/ws"
 *
 * Transport selection:
 *   - `https?://`   → HTTP (Streamable). Bearer token from
 *                     OMCP_FEDERATION_TOKEN_<UPPERCASE-NAME>.
 *   - `ws://`/`wss://` → WebSocket. No bearer header (the SDK
 *                     transport only accepts a URL); embed auth
 *                     in the URL or front the gateway with a
 *                     proxy.
 *   - `stdio:<cmd>` → spawn a child process; `\` escapes spaces
 *                     in the command/argv list.
 *
 * Tokens never appear in the URL list itself for HTTP — kept
 * separate so they don't leak into logs / audit entries.
 */
export interface ParsedUpstreamHttp {
  kind: "http";
  name: string;
  url: string;
  bearerToken?: string;
}

export interface ParsedUpstreamStdio {
  kind: "stdio";
  name: string;
  command: string;
  args: string[];
}

export interface ParsedUpstreamWebsocket {
  kind: "ws";
  name: string;
  url: string;
}

export type ParsedUpstream =
  | ParsedUpstreamHttp
  | ParsedUpstreamStdio
  | ParsedUpstreamWebsocket;

/** Split a "command arg1 arg2" string honouring backslash escapes
 *  so an operator can embed a literal space with `\ `. Nothing
 *  fancier — we explicitly don't run a shell, so quoting wouldn't
 *  apply uniformly. */
function splitCommand(spec: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  let cur = "";
  let esc = false;
  for (const ch of spec) {
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === " " || ch === "\t") {
      if (cur) { tokens.push(cur); cur = ""; }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  const [command = "", ...args] = tokens;
  return { command, args };
}

export function parseFederationEnv(env: NodeJS.ProcessEnv = process.env): ParsedUpstream[] {
  const raw = env.OMCP_FEDERATION_UPSTREAMS?.trim();
  if (!raw) return [];
  const entries: ParsedUpstream[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) {
      console.warn(`OMCP_FEDERATION_UPSTREAMS entry "${trimmed}" missing "=" — skipping`);
      continue;
    }
    const name = trimmed.slice(0, eq).trim();
    const spec = trimmed.slice(eq + 1).trim();
    if (!/^[a-z][a-z0-9_-]*$/i.test(name)) {
      console.warn(`OMCP_FEDERATION_UPSTREAMS entry name "${name}" is invalid — skipping`);
      continue;
    }
    if (spec.startsWith("stdio:")) {
      const { command, args } = splitCommand(spec.slice("stdio:".length).trim());
      if (!command) {
        console.warn(`OMCP_FEDERATION_UPSTREAMS entry "${name}" stdio: missing command — skipping`);
        continue;
      }
      entries.push({ kind: "stdio", name, command, args });
      continue;
    }
    if (/^wss?:\/\//.test(spec)) {
      entries.push({ kind: "ws", name, url: spec });
      continue;
    }
    if (!/^https?:\/\//.test(spec)) {
      console.warn(`OMCP_FEDERATION_UPSTREAMS entry "${name}" url "${spec}" must start with http://, https://, ws://, wss:// (or stdio:) — skipping`);
      continue;
    }
    const tokenEnv = `OMCP_FEDERATION_TOKEN_${name.toUpperCase().replace(/[-.]/g, "_")}`;
    const bearerToken = env[tokenEnv]?.trim() || undefined;
    entries.push({ kind: "http", name, url: spec, bearerToken });
  }
  return entries;
}
