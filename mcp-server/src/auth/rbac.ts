/**
 * Role-based access control for the management plane.
 *
 * Roles are simple string identifiers (`viewer`, `operator`, `admin` ship
 * built-in but the resolver is open-set — a deployment may add any number
 * of custom roles via OIDC group claims, the local users file, or future
 * RBAC config).
 *
 * Permissions are encoded as `<resource>:<action>` pairs. The permission
 * table maps each pair to the set of roles that are granted it. A role
 * with no entries in the table grants nothing.
 *
 * Anonymous mode bypasses RBAC entirely — there is no identity to check.
 * Basic mode runs every mutating /api/* request through `requirePermission`
 * middleware (mounted in index.ts alongside `requireSession`).
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { AuthedRequest, AuthRuntime } from "./middleware.js";
import type { PolicyEngine } from "./policy/engine.js";

export type Action = "read" | "write" | "delete" | "bypass";
export type Resource =
  | "sources"
  | "services"
  | "health"
  | "topology"
  | "settings"
  | "connectors"
  | "audit"
  | "catalog"
  | "users"
  | "redaction"
  | "products"
  | "inspection";

export interface Permission {
  resource: Resource;
  action: Action;
}

/** Built-in default policy. Operators replace this via OMCP_RBAC_POLICY_FILE
 *  (YAML/JSON file → BuiltinPolicyEngine) or OMCP_OPA_URL (external
 *  OPA → OpaPolicyEngine). The gate consumes whichever via
 *  `buildRequirePermissionFromEngine` so tenant-conditional Rego
 *  rules can fire. */
export const DEFAULT_POLICY: Record<string, Permission[]> = {
  viewer: [
    { resource: "sources", action: "read" },
    { resource: "services", action: "read" },
    { resource: "health", action: "read" },
    { resource: "topology", action: "read" },
    { resource: "settings", action: "read" },
    { resource: "connectors", action: "read" },
    { resource: "audit", action: "read" },
    { resource: "catalog", action: "read" },
    { resource: "products", action: "read" },
    { resource: "inspection", action: "read" },
  ],
  operator: [
    // Inherits viewer's read set + write on operational resources.
    { resource: "sources", action: "read" },
    { resource: "sources", action: "write" },
    { resource: "services", action: "read" },
    { resource: "health", action: "read" },
    { resource: "health", action: "write" },
    { resource: "topology", action: "read" },
    { resource: "settings", action: "read" },
    { resource: "settings", action: "write" },
    { resource: "connectors", action: "read" },
    { resource: "audit", action: "read" },
    { resource: "catalog", action: "read" },
    { resource: "products", action: "read" },
    { resource: "products", action: "write" },
    { resource: "inspection", action: "read" },
  ],
  admin: [
    // Full surface — readable + writable + deletable.
    ...(["sources", "services", "health", "topology", "settings", "connectors", "audit", "catalog", "users", "products", "inspection"] as Resource[])
      .flatMap((r) =>
        (["read", "write", "delete"] as Action[]).map<Permission>((a) => ({ resource: r, action: a })),
      ),
    // Special: admins may bypass log-redaction on per-call MCP tool
    // invocations (when the bearer credential ALSO opts in via
    // OMCP_KEY_BYPASS_REDACTION — RBAC is the management-plane gate,
    // the credential flag is the data-plane gate; both must allow).
    { resource: "redaction", action: "bypass" },
  ],
};

/** Resolve whether the given role set grants the requested permission. */
export function hasPermission(
  roles: string[] | undefined,
  resource: Resource,
  action: Action,
  policy: Record<string, Permission[]> = DEFAULT_POLICY,
): boolean {
  if (!roles || roles.length === 0) return false;
  for (const role of roles) {
    const grants = policy[role];
    if (!grants) continue;
    for (const g of grants) {
      if (g.resource === resource && g.action === action) return true;
    }
  }
  return false;
}

/**
 * Express middleware factory. Returns a no-op in anonymous mode, otherwise
 * gates the route on the named permission. Assumes `req.session` has been
 * attached upstream by `buildSessionAttacher` and any auth requirement has
 * already been enforced by `buildRequireSession` — so reaching this point
 * with no session means anonymous mode is active.
 */
export function buildRequirePermission(
  runtime: AuthRuntime,
  resource: Resource,
  action: Action,
  policy: Record<string, Permission[]> = DEFAULT_POLICY,
): RequestHandler {
  if (runtime.mode === "anonymous") {
    return function rbacNoop(_req: Request, _res: Response, next: NextFunction): void {
      next();
    };
  }
  return function rbacGate(req: Request, res: Response, next: NextFunction): void {
    const roles = (req as AuthedRequest).session?.roles;
    if (hasPermission(roles, resource, action, policy)) {
      next();
      return;
    }
    res.status(403).json({
      error: "permission denied",
      code: "OMCP_PERMISSION_DENIED",
      required: { resource, action },
      have: roles ?? [],
    });
  };
}

/**
 * Engine-aware variant of `buildRequirePermission`. Prefer this when an
 * external policy engine (OPA, custom Rego) is in play — the legacy
 * `(roles, resource, action) → boolean` map cannot carry the active
 * tenant, so a Rego rule like `allow { input.tenant == "acme" }` can
 * never fire if you go through the map. This variant calls
 * `engine.evaluate(roles, resource, action, { tenant: session.tenant })`
 * so tenant-conditional rules see the input they need.
 *
 * Anonymous mode stays a no-op — same as the map variant.
 *
 * Performance: `evaluate` is sync by contract. OPA hits its cache; on
 * first miss it returns a conservative deny and warms in the
 * background — the second request inside the TTL gets the real
 * verdict. Documented in opa.ts.
 */
export function buildRequirePermissionFromEngine(
  runtime: AuthRuntime,
  resource: Resource,
  action: Action,
  engine: PolicyEngine,
): RequestHandler {
  if (runtime.mode === "anonymous") {
    return function rbacNoop(_req: Request, _res: Response, next: NextFunction): void {
      next();
    };
  }
  return function rbacGateEngine(req: Request, res: Response, next: NextFunction): void {
    const sess = (req as AuthedRequest).session;
    const verdict = engine.evaluate(sess?.roles, resource, action, { tenant: sess?.tenant });
    if (verdict.allowed) {
      next();
      return;
    }
    res.status(403).json({
      error: "permission denied",
      code: "OMCP_PERMISSION_DENIED",
      required: { resource, action },
      have: sess?.roles ?? [],
      reason: verdict.reason,
    });
  };
}

/** Convenience snapshot for `/api/me` — list every permission the
 * given role set unlocks. Used by the UI to hide write controls the
 * current user can't trigger anyway. */
export function listGrantedPermissions(
  roles: string[] | undefined,
  policy: Record<string, Permission[]> = DEFAULT_POLICY,
): Permission[] {
  if (!roles || roles.length === 0) return [];
  const seen = new Set<string>();
  const out: Permission[] = [];
  for (const role of roles) {
    const grants = policy[role];
    if (!grants) continue;
    for (const g of grants) {
      const key = `${g.resource}:${g.action}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(g);
    }
  }
  return out;
}
