/**
 * Policy-engine abstraction.
 *
 * Today the management-plane RBAC checks call `hasPermission()` /
 * `listGrantedPermissions()` which read the built-in DEFAULT_POLICY
 * map. That's fine for the single-deployment case, but the plan
 * (E5) wires in:
 *
 *   - File-loaded custom policies (slice 2, this module)
 *   - External OPA via HTTP eval (slice 4)
 *
 * Both surfaces share the same shape: given (role, resource, action),
 * answer allowed / not allowed; and given a role, enumerate every
 * granted (resource, action) pair for UI display.
 *
 * This interface is deliberately narrow so a future Rego engine, a
 * remote OPA call, or any operator-supplied evaluator drops in
 * without touching the call sites.
 */

import type { Permission, Resource, Action } from "../rbac.js";

export interface EvalResult {
  allowed: boolean;
  /** Optional human-readable explanation (for /api/policy?dry-run). */
  reason?: string;
}

/** Optional context the gate can pass when it has more identity
 *  info than just the role set — e.g. the active tenant. Engines
 *  that consult external policy (OPA) thread this into the Rego
 *  input so tenant-conditional rules can fire. Built-in engines
 *  ignore it. Adding fields here is additive: future-engine code
 *  reads what it needs, callers populate what they have. */
export interface EvalContext {
  tenant?: string;
}

export interface PolicyEngine {
  /** One-shot evaluation: does this role-set grant the permission? */
  evaluate(roles: string[] | undefined, resource: Resource, action: Action, ctx?: EvalContext): EvalResult;
  /** Enumerate every (resource, action) the role-set grants. */
  list(roles: string[] | undefined, ctx?: EvalContext): Permission[];
  /** Surface the active role catalogue (for UI tabs / docs). */
  roles(): string[];
  /** Short identifier for logging / /api/info — "builtin", "file:…",
   *  "opa:…". */
  kind(): string;
}

/** Built-in engine — wraps a plain {role: Permission[]} map. */
export class BuiltinPolicyEngine implements PolicyEngine {
  private readonly policy: Record<string, Permission[]>;
  private readonly origin: string;

  constructor(policy: Record<string, Permission[]>, origin: string = "builtin") {
    this.policy = policy;
    this.origin = origin;
  }

  evaluate(roles: string[] | undefined, resource: Resource, action: Action, _ctx?: EvalContext): EvalResult {
    void _ctx; // builtin engine has no tenant-conditional rules
    if (!roles || roles.length === 0) {
      return { allowed: false, reason: "no roles on principal" };
    }
    for (const r of roles) {
      const grants = this.policy[r];
      if (!grants) continue;
      for (const g of grants) {
        if (g.resource === resource && g.action === action) {
          return { allowed: true, reason: `granted by role ${r}` };
        }
      }
    }
    return { allowed: false, reason: `roles [${roles.join(",")}] do not grant ${resource}:${action}` };
  }

  list(roles: string[] | undefined, _ctx?: EvalContext): Permission[] {
    void _ctx;
    if (!roles || roles.length === 0) return [];
    const seen = new Set<string>();
    const out: Permission[] = [];
    for (const r of roles) {
      const grants = this.policy[r];
      if (!grants) continue;
      for (const g of grants) {
        const key = g.resource + ":" + g.action;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(g);
      }
    }
    return out;
  }

  roles(): string[] {
    return Object.keys(this.policy);
  }

  kind(): string {
    return this.origin;
  }

  /** Expose the underlying policy for /api/policy reflection. */
  raw(): Record<string, Permission[]> {
    return this.policy;
  }
}
