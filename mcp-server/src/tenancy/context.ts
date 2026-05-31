/**
 * Multi-tenant context primitives.
 *
 * Every request lands in EXACTLY ONE tenant. Identities resolve to a
 * tenant via one of three paths:
 *
 *   1. Anonymous (no auth, the demo / single-operator path) → DEFAULT_TENANT.
 *   2. Basic-mode local user → user file's optional `tenant` field;
 *      missing → DEFAULT_TENANT (so existing single-tenant deployments
 *      keep working without any config change).
 *   3. OIDC session → OMCP_OIDC_TENANT_CLAIM (default `tenant`);
 *      empty / missing claim → DEFAULT_TENANT.
 *   4. MCP credential (bearer token) → optional per-credential
 *      `tenant` field assigned via OMCP_KEY_TENANTS env, mirroring
 *      OMCP_KEY_SOURCES / OMCP_KEY_BYPASS_REDACTION shape.
 *
 * The constant `DEFAULT_TENANT` is the universal escape hatch — any
 * non-multi-tenant deployment behaves as if everything is in
 * tenant `default`, identical to the pre-E7 single-namespace world.
 *
 * Cross-tenant requests return 404 (not 403) per the plan — leaking
 * existence by status code defeats half the point of isolation.
 */

export const DEFAULT_TENANT = "default";

/** Maximum tenant identifier length. Defence-in-depth against a
 *  hostile claim payload pushing arbitrary KB-sized strings through
 *  every cookie. Operators with longer names should pick shorter
 *  ones; the audit chain still hashes the full string but the
 *  cookie payload + log lines stay bounded. */
export const MAX_TENANT_LENGTH = 64;

/** Pattern: alphanumeric + `-` + `_` + `.`. Mirrors what most CI
 *  identifiers accept. Rejects `/`, space, control chars (which
 *  could break filesystem layouts in slice 2). */
const VALID_TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Normalise + validate a tenant identifier. Returns the trimmed,
 *  lower-cased string when valid; DEFAULT_TENANT for empty or
 *  invalid input (silent fallback rather than crash — an OIDC claim
 *  with junk should drop the user into the safe default, not 500
 *  the whole flow). */
export function normaliseTenant(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_TENANT;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return DEFAULT_TENANT;
  if (trimmed.length > MAX_TENANT_LENGTH) return DEFAULT_TENANT;
  if (!VALID_TENANT_RE.test(trimmed)) return DEFAULT_TENANT;
  return trimmed;
}

/** Walk a dotted-path claim out of an arbitrary claim set, then
 *  normalise. Used for OIDC sessions where the tenant lives at e.g.
 *  `app.tenant_id` rather than the top level. */
export function tenantFromClaim(claims: Record<string, unknown>, claimPath: string): string {
  if (!claimPath) return DEFAULT_TENANT;
  const parts = claimPath.split(".");
  let cur: unknown = claims;
  for (const p of parts) {
    if (cur && typeof cur === "object" && !Array.isArray(cur) && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return DEFAULT_TENANT;
    }
  }
  // Arrays: take the first string-shaped entry (the same posture as
  // resolveRoles in auth/oidc/runtime.ts). Operators wanting per-call
  // multi-tenancy should use one tenant claim per token, not a list.
  if (Array.isArray(cur)) {
    for (const v of cur) if (typeof v === "string") return normaliseTenant(v);
    return DEFAULT_TENANT;
  }
  return normaliseTenant(cur);
}

/** Parse OMCP_KEY_TENANTS="ci=acme;agent=bigco" into a name → tenant
 *  map. Mirrors parseKeySources in auth/credentials.ts so the operator
 *  cognitive load stays low. Invalid tenant strings normalise to
 *  DEFAULT_TENANT silently. */
export function parseKeyTenants(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw) return out;
  for (const entry of raw.split(";").map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const name = entry.slice(0, eq).trim();
    const tenant = normaliseTenant(entry.slice(eq + 1).trim());
    if (name) out.set(name, tenant);
  }
  return out;
}
