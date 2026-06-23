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
 *   OMCP_KEY_RAW_QUERY="agent,ci"
 *                  # optional comma-separated list of key NAMES allowed to
 *                  # run raw_query even when the global OMCP_RAW_QUERY
 *                  # capability is off. Effective gate = global OR per-key,
 *                  # so it only widens; off by default for every key.
 *   OMCP_KEY_TENANTS="agent=acme;ci=bigco"
 *                  # optional per-key tenant assignment. Unlisted keys
 *                  # land in the "default" tenant — identical to the
 *                  # pre-E7 single-namespace world. See docs/tenancy.md
 *                  # (slice 5) for the cross-cutting model.
 *   OMCP_KEY_PRODUCTS="agent=ops-bundle;ci=dev-bundle"
 *                  # optional per-key Product binding. When set, the
 *                  # /mcp tools/list response is filtered to the named
 *                  # Product's `tools` allow-list (Product without a
 *                  # tools list = no restriction). Unlisted keys see
 *                  # every registered tool — back-compat with the
 *                  # pre-Products world. See docs/products.md.
 *   OMCP_KEY_TOOLS="agent=query_logs|get_service_health;ci=list_services"
 *                  # optional per-key tool allow-list — same shape as
 *                  # OMCP_KEY_SOURCES. When set, the credential's /mcp
 *                  # tools/list (and dispatch) is scoped to exactly these
 *                  # tool names. Composes with a bound Product by
 *                  # INTERSECTION (most-restrictive wins). Unlisted keys
 *                  # see every registered tool — back-compat. This is the
 *                  # per-credential, source-symmetric counterpart to the
 *                  # Product bundle: scope one API key to a few tools
 *                  # without authoring a Product. See docs/products.md
 *                  # ("Per-credential tool allow-list").
 *
 * Rich role-based access control (services/lookback/read-only, the full
 * governance object) is intentionally NOT here — this is the authentication
 * + identity + coarse source/tool-scoping primitive.
 */

import { parseKeyTenants } from "../tenancy/context.js";

export interface Credential {
  name: string;
  token: string;
  allowedSources?: string[];
  /** True when the operator opted this credential into the per-call
   *  redaction bypass. The bypass still requires the MCP tool caller
   *  to explicitly set `bypass_redaction: true` in the tool args —
   *  this flag only authorises it; it never auto-disables redaction. */
  bypassRedaction?: boolean;
  /** True when the operator opted this credential into running `raw_query`
   *  even with the global OMCP_RAW_QUERY capability off. Configured via
   *  OMCP_KEY_RAW_QUERY. The effective gate is `global OR per-credential` —
   *  it only widens access, never narrows a globally-enabled deployment. */
  allowRawQuery?: boolean;
  /** Tenant this credential belongs to. Omitted → DEFAULT_TENANT. */
  tenant?: string;
  /** Product id this credential is bound to. When set, /mcp tools/list
   *  is filtered to the Product's `tools` allow-list. Resolved against
   *  the credential's tenant so cross-tenant Products don't leak. */
  productId?: string;
  /** Per-credential tool allow-list (OMCP_KEY_TOOLS). When set, /mcp
   *  tools/list and dispatch are scoped to these tool names; composes
   *  with a bound Product by intersection (most-restrictive wins).
   *  Undefined → no per-credential tool restriction (back-compat). */
  allowedTools?: string[];
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

/** Parse OMCP_KEY_PRODUCTS — `name=productId;name2=productId2`. Same
 *  shape as parseKeyTenants (single id per credential — Products are
 *  bundles, not bundles-of-bundles). */
function parseKeyProducts(raw: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (!raw) return m;
  for (const entry of raw.split(";").map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const name = entry.slice(0, eq).trim();
    const productId = entry.slice(eq + 1).trim();
    if (name && productId) m.set(name, productId);
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
  const rawQueryNames = parseBypassSet(env.OMCP_KEY_RAW_QUERY);
  const keyTenants = parseKeyTenants(env.OMCP_KEY_TENANTS);
  const keyProducts = parseKeyProducts(env.OMCP_KEY_PRODUCTS);
  // OMCP_KEY_TOOLS shares the OMCP_KEY_SOURCES grammar (`name=a|b;name2=c`).
  const keyTools = parseKeySources(env.OMCP_KEY_TOOLS);
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
      allowRawQuery: rawQueryNames.has(name) || undefined,
      tenant: keyTenants.get(name) || undefined,
      productId: keyProducts.get(name) || undefined,
      allowedTools: keyTools.get(name),
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
