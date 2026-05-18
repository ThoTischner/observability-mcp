// RBAC enforcement guard (FSL-1.1-Apache-2.0).
//
// Bridges the Apache-2.0 core's request seam to the pure policy
// evaluator WITHOUT the core ever importing FSL code: `enforce` is
// duck-typed against the core RequestContext shape
// ({ principalId, auth, allowedSources?, ... }). An operator wires it in
// at the context seam — resolve the principal from `ctx`, then call
// `enforce(policy, ctx, { tool, source?, service?, mutating? })` before a
// tool runs; a denial throws and the tool never executes.
//
// RBAC composes WITH, never widens, the core's single-tenant
// `allowedSources` primitive: if the context pins a source allow-list,
// a targeted source outside it is denied before the policy is consulted
// (defence in depth — the narrower bound always wins).

import { evaluate } from "./policy.mjs";

export class RbacDeniedError extends Error {
  constructor(decision, request) {
    super(`RBAC denied: ${decision.reason}`);
    this.name = "RbacDeniedError";
    this.code = "RBAC_DENIED";
    this.decision = decision;
    this.request = request;
  }
}

/**
 * Enforce a policy for a request in the scope of a core RequestContext.
 * @param policy  the RBAC policy
 * @param ctx     duck-typed RequestContext ({ principalId, allowedSources? })
 * @param request { tool, source?, service?, mutating? }
 * @returns the allow decision (on deny it throws RbacDeniedError)
 */
export function enforce(policy, ctx, request) {
  const c = ctx || {};
  const req = {
    principalId: c.principalId,
    tool: request && request.tool,
    source: request && request.source,
    service: request && request.service,
    mutating: !!(request && request.mutating),
  };

  // Core single-tenant bound is an upper limit RBAC cannot exceed.
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
    throw new RbacDeniedError(decision, req);
  }

  const decision = evaluate(policy, req);
  if (!decision.allow) throw new RbacDeniedError(decision, req);
  return decision;
}

/**
 * Non-throwing variant — returns the decision for callers that want to
 * branch rather than catch.
 */
export function check(policy, ctx, request) {
  try {
    return enforce(policy, ctx, request);
  } catch (e) {
    if (e instanceof RbacDeniedError) return e.decision;
    throw e;
  }
}
