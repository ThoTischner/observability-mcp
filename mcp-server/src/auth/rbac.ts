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

export type Action = "read" | "write" | "delete";
export type Resource =
  | "sources"
  | "services"
  | "health"
  | "topology"
  | "settings"
  | "connectors"
  | "audit"
  | "users";

export interface Permission {
  resource: Resource;
  action: Action;
}

/** Built-in default policy. Operators can replace this via OMCP_RBAC_POLICY in a follow-up. */
export const DEFAULT_POLICY: Record<string, Permission[]> = {
  viewer: [
    { resource: "sources", action: "read" },
    { resource: "services", action: "read" },
    { resource: "health", action: "read" },
    { resource: "topology", action: "read" },
    { resource: "settings", action: "read" },
    { resource: "connectors", action: "read" },
    { resource: "audit", action: "read" },
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
  ],
  admin: [
    // Full surface — readable + writable + deletable.
    ...(["sources", "services", "health", "topology", "settings", "connectors", "audit", "users"] as Resource[])
      .flatMap((r) =>
        (["read", "write", "delete"] as Action[]).map<Permission>((a) => ({ resource: r, action: a })),
      ),
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
