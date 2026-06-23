import { randomUUID } from "node:crypto";

import { DEFAULT_TENANT, normaliseTenant } from "./tenancy/context.js";

/**
 * Request-scoped context threaded from the transport boundary (HTTP `/mcp`,
 * stdio, and the internal REST/dashboard call sites) into every tool handler.
 *
 * Today it carries only an anonymous principal and a correlation id — it is a
 * deliberate pass-through that does not change behaviour. It is the single
 * seam that later access-control / scoping / audit work attaches to, so those
 * features become additive rather than a cross-cutting rewrite.
 */
export interface RequestContext {
  /** Stable id for the calling principal. "anonymous" when no auth configured. */
  principalId: string;
  /** How the principal was authenticated. */
  auth: "anonymous" | "apikey";
  /**
   * Coarse per-credential source allow-list (single-tenant primitive). When
   * set, the principal may only target these source names. Rich role-based
   * scoping (tools/services/lookback/read-only) is a separate concern.
   */
  allowedSources?: string[];
  /** When true, the credential is allowed to opt out of redaction on a
   *  per-tool-call basis. The actual bypass is engaged only when the
   *  tool call ALSO sets `bypass_redaction: true` in its args. Default
   *  false. Configured via OMCP_KEY_BYPASS_REDACTION. */
  allowBypassRedaction?: boolean;
  /** When true, this credential may run `raw_query` even if the global
   *  OMCP_RAW_QUERY capability is off. Per-credential gating (configured via
   *  OMCP_KEY_RAW_QUERY) — the effective gate is `global OR per-credential`,
   *  so a global enable still works and this only widens, never narrows.
   *  Default false. */
  allowRawQuery?: boolean;
  /** Tenant the request operates in. ALWAYS set — defaults to
   *  "default" for anonymous principals + missing-tenant credentials,
   *  preserving the single-namespace behaviour of pre-E7 deployments. */
  tenant: string;
  /** When set, the /mcp tools/list response is filtered to this
   *  allow-list. Resolved from the active credential's bound Product
   *  (OMCP_KEY_PRODUCTS) against the catalogue at request entry.
   *  Anonymous + Product-less credentials leave this unset and see
   *  every registered tool. */
  allowedTools?: string[];
  /** Per-credential tool allow-list (OMCP_KEY_TOOLS) — a SEPARATE axis from
   *  the Product `allowedTools`. The registration gate requires a tool to
   *  pass BOTH (each via allowsTool, undefined = no restriction), so the two
   *  compose by intersection without overloading the empty-list semantics.
   *  Unset for anonymous + unscoped credentials. */
  credentialTools?: string[];
  /** Correlates all tool calls within one transport request/session. */
  correlationId: string;
}

/** Default all-access anonymous context — preserves current behaviour.
 *  `opts.allowBypassRedaction` lets an operator opt the anonymous identity
 *  into per-call redaction bypass (OMCP_BYPASS_REDACTION_ANON) — in an
 *  anonymous deployment there is no named credential to add to
 *  OMCP_KEY_BYPASS_REDACTION, so this is the only way a single-user
 *  self-hosted agent can see raw IPs on its own logs without the blunt
 *  global OMCP_REDACTION=off. Defaults off; all existing call sites that
 *  omit opts are unchanged. */
export function defaultContext(opts: { allowBypassRedaction?: boolean } = {}): RequestContext {
  return {
    principalId: "anonymous",
    auth: "anonymous",
    tenant: DEFAULT_TENANT,
    allowBypassRedaction: opts.allowBypassRedaction || undefined,
    correlationId: randomUUID(),
  };
}

/** Context for an authenticated API-key principal. */
export function principalContext(
  principalId: string,
  allowedSources?: string[],
  opts: { allowBypassRedaction?: boolean; allowRawQuery?: boolean; tenant?: string; allowedTools?: string[]; credentialTools?: string[] } = {},
): RequestContext {
  return {
    principalId,
    auth: "apikey",
    allowedSources: allowedSources && allowedSources.length > 0 ? allowedSources : undefined,
    allowBypassRedaction: opts.allowBypassRedaction || undefined,
    allowRawQuery: opts.allowRawQuery || undefined,
    tenant: normaliseTenant(opts.tenant),
    allowedTools: opts.allowedTools && opts.allowedTools.length > 0 ? opts.allowedTools : undefined,
    credentialTools: opts.credentialTools && opts.credentialTools.length > 0 ? opts.credentialTools : undefined,
    correlationId: randomUUID(),
  };
}

/** Context for an authenticated management-plane (browser / OIDC /
 *  basic-auth) request. The session-derived tenant flows into tool
 *  handlers exactly like the MCP-credential path, so a viewer in
 *  tenant Acme reading /api/services through the dashboard sees the
 *  same service set as an /mcp client bound to Acme. Anonymous mode
 *  (no session) → behaves like defaultContext(). */
export function sessionContext(
  session: { sub?: string; name?: string; tenant?: string } | undefined,
): RequestContext {
  if (!session) return defaultContext();
  return {
    principalId: session.sub || session.name || "anonymous",
    auth: "apikey",
    tenant: normaliseTenant(session.tenant),
    correlationId: randomUUID(),
  };
}

/** Decide whether a given tool name is accessible under the active
 *  Product binding. Pure helper so the registration site stays
 *  declarative and the filtering policy is unit-testable in isolation.
 *
 *  Semantics:
 *    - undefined allow-list → no Product binding, every tool allowed
 *      (anonymous + Product-less credentials — back-compat).
 *    - empty allow-list → a Product with no `tools` field. The schema
 *      treats this as "all tools allowed", matching the YAML loader's
 *      view that an absent / empty list means no restriction.
 *    - non-empty → the named tool must appear verbatim.
 *  Tool names are compared case-sensitively; the MCP spec is
 *  case-sensitive on `name`. */
export function allowsTool(allowedTools: string[] | undefined, toolName: string): boolean {
  if (!allowedTools || allowedTools.length === 0) return true;
  return allowedTools.includes(toolName);
}

/** Combine two tool allow-lists into the effective (most-restrictive) one.
 *  Both lists NARROW access, so the result is their intersection:
 *    - either side undefined → the other side wins (an absent list means
 *      "no restriction", so it can't tighten the other).
 *    - both set → only tools present in BOTH survive (so a per-credential
 *      OMCP_KEY_TOOLS list and a bound Product's `tools` list compose
 *      without one silently widening the other; an empty intersection
 *      means the credential can call nothing through that binding).
 *  Used to fold the per-credential allow-list together with the Product
 *  allow-list at request entry. */
export function intersectAllowed(
  a: string[] | undefined,
  b: string[] | undefined,
): string[] | undefined {
  if (!a) return b;
  if (!b) return a;
  const bSet = new Set(b);
  return a.filter((t) => bSet.has(t));
}
