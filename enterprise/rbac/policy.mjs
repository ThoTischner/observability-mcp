// Role-based access-control policy evaluator (FSL-1.1-Apache-2.0).
//
// Pure and dependency-free: no I/O, no clock, no global state — a policy
// + a request in, an allow/deny decision out. That makes it exhaustively
// unit-testable and safe to call on every tool invocation.
//
// Model
// -----
//   Policy  = { roles, bindings, defaultRoles? }
//     roles      : { <roleName>: Role }
//     bindings   : { <principalId>: string[] }   // roles granted to a principal
//     defaultRoles?: string[]                    // roles for unbound principals
//   Role    = { tools?, sources?, services?, readOnly? }
//     tools/sources/services : string[] allow-lists; "*" = any; omitted = none
//     readOnly?              : true → the role denies mutating actions
//   Request = { principalId, tool, source?, service?, mutating? }
//
// Decision: DEFAULT-DENY. A request is allowed only if at least one role
// bound to the principal grants the tool AND (when given) the source AND
// (when given) the service, and — if that role is readOnly — the action
// is not mutating. Multiple roles compose as a union (any fully-granting
// role allows). An unknown/unbound principal gets `defaultRoles` (if any)
// or is denied.

function listAllows(list, value) {
  // An omitted/empty allow-list grants nothing (default-deny). "*" grants
  // everything. Otherwise the exact value must be present.
  if (!Array.isArray(list) || list.length === 0) return false;
  if (list.includes("*")) return true;
  return value != null && list.includes(value);
}

/** Roles bound to a principal, falling back to policy.defaultRoles. */
export function rolesFor(policy, principalId) {
  const bound = (policy && policy.bindings && policy.bindings[principalId]) || null;
  if (bound && bound.length > 0) return bound;
  return (policy && policy.defaultRoles) || [];
}

/**
 * Evaluate a request against a policy.
 * @returns {{allow: boolean, reason: string, matchedRole?: string}}
 */
export function evaluate(policy, request) {
  if (!policy || typeof policy !== "object") {
    return { allow: false, reason: "no policy configured (default-deny)" };
  }
  const req = request || {};
  if (!req.tool) {
    return { allow: false, reason: "request has no tool" };
  }
  const roleNames = rolesFor(policy, req.principalId);
  if (roleNames.length === 0) {
    return {
      allow: false,
      reason: `principal '${req.principalId ?? "?"}' has no roles (default-deny)`,
    };
  }

  const tried = [];
  for (const roleName of roleNames) {
    const role = policy.roles && policy.roles[roleName];
    if (!role) {
      tried.push(`${roleName}: undefined role`);
      continue;
    }
    if (!listAllows(role.tools, req.tool)) {
      tried.push(`${roleName}: tool '${req.tool}' not granted`);
      continue;
    }
    if (req.source != null && !listAllows(role.sources, req.source)) {
      tried.push(`${roleName}: source '${req.source}' not granted`);
      continue;
    }
    if (req.service != null && !listAllows(role.services, req.service)) {
      tried.push(`${roleName}: service '${req.service}' not granted`);
      continue;
    }
    if (role.readOnly && req.mutating) {
      tried.push(`${roleName}: read-only role denies a mutating action`);
      continue;
    }
    return { allow: true, reason: `granted by role '${roleName}'`, matchedRole: roleName };
  }

  return {
    allow: false,
    reason: `denied — no bound role grants this request [${tried.join("; ")}]`,
  };
}
