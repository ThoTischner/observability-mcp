/**
 * Single-tenant authentication primitive (opt-in, backward compatible).
 *
 * If no credentials are configured the server behaves exactly as before
 * (anonymous, all access). If `OMCP_API_KEYS` is set, the `/mcp` endpoint
 * requires a valid `Authorization: Bearer <token>` or `X-API-Key: <token>`.
 *
 * Config (env, no secrets in files):
 *   OMCP_API_KEYS="ci:tok_abc,agent:tok_def"   # name:token, comma-separated
 *                  (a bare "tok_xyz" is allowed; name defaults to "key")
 *   OMCP_KEY_SOURCES="agent=prom-prod|loki-prod;ci=prom-staging"
 *                  # optional coarse per-key source allow-list
 *   OMCP_KEY_BYPASS_REDACTION="agent,ci"
 *                  # optional comma-separated list of key NAMES allowed
 *                  # to bypass log-payload redaction on per-call request
 *                  # via the bypass_redaction tool arg. Off by default
 *                  # for every key — pair with the redaction:bypass
 *                  # RBAC permission for the management-plane angle.
 *
 * Rich role-based access control (tools/services/lookback/read-only, the
 * full governance object) is intentionally NOT here — this is only the
 * authentication + identity + coarse source-scoping primitive.
 */

export interface Credential {
  name: string;
  token: string;
  allowedSources?: string[];
  /** True when the operator opted this credential into the per-call
   *  redaction bypass. The bypass still requires the MCP tool caller
   *  to explicitly set `bypass_redaction: true` in the tool args —
   *  this flag only authorises it; it never auto-disables redaction. */
  bypassRedaction?: boolean;
}

function parseKeySources(raw: string | undefined): Map<string, string[]> {
  const m = new Map<string, string[]>();
  if (!raw) return m;
  for (const entry of raw.split(";").map((s) => s.trim()).filter(Boolean)) {
    const [name, list] = entry.split("=");
    if (!name || !list) continue;
    m.set(
      name.trim(),
      list.split("|").map((s) => s.trim()).filter(Boolean)
    );
  }
  return m;
}

function parseBypassSet(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/** Parse credentials from env. Returns an empty list when unconfigured. */
export function loadCredentials(env: NodeJS.ProcessEnv = process.env): Credential[] {
  const raw = env.OMCP_API_KEYS?.trim();
  if (!raw) return [];
  const keySources = parseKeySources(env.OMCP_KEY_SOURCES);
  const bypassNames = parseBypassSet(env.OMCP_KEY_BYPASS_REDACTION);
  const creds: Credential[] = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const idx = part.indexOf(":");
    const name = idx > 0 ? part.slice(0, idx).trim() : "key";
    const token = (idx > 0 ? part.slice(idx + 1) : part).trim();
    if (!token) continue;
    creds.push({
      name,
      token,
      allowedSources: keySources.get(name),
      bypassRedaction: bypassNames.has(name) || undefined,
    });
  }
  return creds;
}

export function credentialsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return loadCredentials(env).length > 0;
}

/** Extract a bearer/api-key token from request headers. */
export function extractToken(headers: Record<string, unknown>): string | null {
  const auth = headers["authorization"];
  if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim() || null;
  }
  const apiKey = headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim()) return apiKey.trim();
  return null;
}

/** Constant-time-ish token match → resolved credential, or null. */
export function resolveToken(
  token: string | null,
  creds: Credential[]
): Credential | null {
  if (!token) return null;
  for (const c of creds) {
    if (c.token.length === token.length && safeEqual(c.token, token)) return c;
  }
  return null;
}

function safeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
