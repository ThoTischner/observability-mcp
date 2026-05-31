/**
 * Load a policy from a YAML or JSON file and turn it into a
 * BuiltinPolicyEngine. Validation enforces every entry has a
 * known resource + action shape; unknown fields are rejected so a
 * typo in operator-facing config fails fast and loud rather than
 * silently dropping grants.
 *
 * File shape:
 *   roles:
 *     viewer:
 *       - { resource: sources, action: read }
 *       - { resource: services, action: read }
 *     operator:
 *       - { resource: sources, action: write }
 *       - { resource: settings, action: write }
 *     admin:
 *       - { resource: redaction, action: bypass }
 *       # etc.
 *
 * The loader does NOT inherit-merge built-in roles — a file-supplied
 * `admin` REPLACES the built-in `admin`. Inheritance / patching is
 * an operator-side concern (anchor / merge in YAML, jq filters, etc.).
 */

import { readFileSync } from "node:fs";
import yaml from "js-yaml";

import type { Permission, Resource, Action } from "../rbac.js";
import { BuiltinPolicyEngine, type PolicyEngine } from "./engine.js";

export const VALID_RESOURCES: ReadonlySet<Resource> = new Set([
  "sources", "services", "health", "topology", "settings",
  "connectors", "audit", "catalog", "users", "redaction",
]);
export const VALID_ACTIONS: ReadonlySet<Action> = new Set(["read", "write", "delete", "bypass"]);

export class PolicyLoadError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PolicyLoadError";
  }
}

/** Parse a YAML/JSON string into a validated policy + return an engine. */
export function loadPolicyFromString(text: string, origin: string): PolicyEngine {
  let parsed: unknown;
  try {
    parsed = yaml.load(text);
  } catch (e) {
    throw new PolicyLoadError(`failed to parse policy ${origin}: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PolicyLoadError(`${origin}: expected an object with a 'roles' map`);
  }
  const roles = (parsed as Record<string, unknown>).roles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) {
    throw new PolicyLoadError(`${origin}: missing or non-object 'roles' field`);
  }
  const policy: Record<string, Permission[]> = {};
  for (const [role, grants] of Object.entries(roles as Record<string, unknown>)) {
    if (!Array.isArray(grants)) {
      throw new PolicyLoadError(`${origin}: roles.${role} must be a list of {resource, action} entries`);
    }
    const perms: Permission[] = [];
    for (let i = 0; i < grants.length; i++) {
      const g = grants[i];
      if (!g || typeof g !== "object" || Array.isArray(g)) {
        throw new PolicyLoadError(`${origin}: roles.${role}[${i}] must be an object`);
      }
      // Reject unexpected keys FIRST so a typo like `tesource:` gets
      // the helpful "unexpected key 'tesource'" message instead of
      // the misleading "resource 'undefined' unknown" that the value
      // check below would otherwise emit (no `resource` field
      // present in the object).
      for (const k of Object.keys(g as Record<string, unknown>)) {
        if (k !== "resource" && k !== "action") {
          throw new PolicyLoadError(`${origin}: roles.${role}[${i}] has unexpected key '${k}'`);
        }
      }
      const resource = (g as Record<string, unknown>).resource;
      const action = (g as Record<string, unknown>).action;
      if (typeof resource !== "string" || !VALID_RESOURCES.has(resource as Resource)) {
        throw new PolicyLoadError(`${origin}: roles.${role}[${i}].resource '${String(resource)}' unknown (allowed: ${[...VALID_RESOURCES].join(", ")})`);
      }
      if (typeof action !== "string" || !VALID_ACTIONS.has(action as Action)) {
        throw new PolicyLoadError(`${origin}: roles.${role}[${i}].action '${String(action)}' unknown (allowed: ${[...VALID_ACTIONS].join(", ")})`);
      }
      perms.push({ resource: resource as Resource, action: action as Action });
    }
    policy[role] = perms;
  }
  return new BuiltinPolicyEngine(policy, origin);
}

/** Read a file (utf-8) and load it as a policy. Lets operators
 *  surface the on-disk path in error messages. */
export function loadPolicyFromFile(path: string): PolicyEngine {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new PolicyLoadError(`failed to read policy ${path}: ${(e as Error).message}`);
  }
  return loadPolicyFromString(text, `file:${path}`);
}
