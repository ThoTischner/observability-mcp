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
  /** Tenant the request operates in. ALWAYS set — defaults to
   *  "default" for anonymous principals + missing-tenant credentials,
   *  preserving the single-namespace behaviour of pre-E7 deployments. */
  tenant: string;
  /** Correlates all tool calls within one transport request/session. */
  correlationId: string;
}

/** Default all-access anonymous context — preserves current behaviour. */
export function defaultContext(): RequestContext {
  return {
    principalId: "anonymous",
    auth: "anonymous",
    tenant: DEFAULT_TENANT,
    correlationId: randomUUID(),
  };
}

/** Context for an authenticated API-key principal. */
export function principalContext(
  principalId: string,
  allowedSources?: string[],
  opts: { allowBypassRedaction?: boolean; tenant?: string } = {},
): RequestContext {
  return {
    principalId,
    auth: "apikey",
    allowedSources: allowedSources && allowedSources.length > 0 ? allowedSources : undefined,
    allowBypassRedaction: opts.allowBypassRedaction || undefined,
    tenant: normaliseTenant(opts.tenant),
    correlationId: randomUUID(),
  };
}
