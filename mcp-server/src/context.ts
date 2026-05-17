import { randomUUID } from "node:crypto";

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
  /** Correlates all tool calls within one transport request/session. */
  correlationId: string;
}

/** Default all-access anonymous context — preserves current behaviour. */
export function defaultContext(): RequestContext {
  return {
    principalId: "anonymous",
    auth: "anonymous",
    correlationId: randomUUID(),
  };
}

/** Context for an authenticated API-key principal. */
export function principalContext(
  principalId: string,
  allowedSources?: string[]
): RequestContext {
  return {
    principalId,
    auth: "apikey",
    allowedSources: allowedSources && allowedSources.length > 0 ? allowedSources : undefined,
    correlationId: randomUUID(),
  };
}
