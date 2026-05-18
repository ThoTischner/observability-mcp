// Catalog enforcement guard (FSL-1.1-Apache-2.0).
//
// Mirrors enterprise/rbac/enforce.mjs: duck-typed against the core
// RequestContext shape so the Apache core never imports FSL code, and
// composes with — never widens — the single-tenant `allowedSources`
// bound (the narrowest bound always wins).
//
// Intended composition (defence in depth): an operator calls the RBAC
// guard AND this catalog guard before a tool runs. RBAC answers "may
// this principal perform this verb?"; the catalog answers "is this
// resource within a product they were granted?". Both must allow.

import { evaluateCatalog } from "./catalog.mjs";

export class CatalogDeniedError extends Error {
  constructor(decision, request) {
    super(`Catalog denied: ${decision.reason}`);
    this.name = "CatalogDeniedError";
    this.code = "CATALOG_DENIED";
    this.decision = decision;
    this.request = request;
  }
}

/**
 * Enforce a catalog for a request in the scope of a core RequestContext.
 * @param catalog the product catalog
 * @param ctx     duck-typed RequestContext ({ principalId, allowedSources? })
 * @param request { source?, service?, tool? }
 * @returns the allow decision (on deny it throws CatalogDeniedError)
 */
export function enforceCatalog(catalog, ctx, request) {
  const c = ctx || {};
  const req = {
    principalId: c.principalId,
    source: request && request.source,
    service: request && request.service,
    tool: request && request.tool,
  };

  if (
    req.source != null &&
    Array.isArray(c.allowedSources) &&
    c.allowedSources.length > 0 &&
    !c.allowedSources.includes(req.source)
  ) {
    const decision = {
      allow: false,
      reason: `source '${req.source}' outside the context allow-list`,
    };
    throw new CatalogDeniedError(decision, req);
  }

  const decision = evaluateCatalog(catalog, req);
  if (!decision.allow) throw new CatalogDeniedError(decision, req);
  return decision;
}

/** Non-throwing variant — returns the decision. */
export function checkCatalog(catalog, ctx, request) {
  try {
    return enforceCatalog(catalog, ctx, request);
  } catch (e) {
    if (e instanceof CatalogDeniedError) return e.decision;
    throw e;
  }
}
