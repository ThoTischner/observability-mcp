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
 *   "name1=https://gw.a/mcp,name2=https://gw.b/mcp"
 *
 * Each upstream's bearer token is read from
 * OMCP_FEDERATION_TOKEN_<UPPERCASE-NAME> (dots → underscores), so
 * tokens stay out of the URL list itself.
 */
export interface ParsedUpstream {
  name: string;
  url: string;
  bearerToken?: string;
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
    const url = trimmed.slice(eq + 1).trim();
    if (!/^[a-z][a-z0-9_-]*$/i.test(name)) {
      console.warn(`OMCP_FEDERATION_UPSTREAMS entry name "${name}" is invalid — skipping`);
      continue;
    }
    if (!/^https?:\/\//.test(url)) {
      console.warn(`OMCP_FEDERATION_UPSTREAMS entry "${name}" url "${url}" must start with http:// or https:// — skipping`);
      continue;
    }
    const tokenEnv = `OMCP_FEDERATION_TOKEN_${name.toUpperCase().replace(/[-.]/g, "_")}`;
    const bearerToken = env[tokenEnv]?.trim() || undefined;
    entries.push({ name, url, bearerToken });
  }
  return entries;
}
