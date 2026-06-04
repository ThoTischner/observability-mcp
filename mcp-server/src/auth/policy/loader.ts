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
  "products",
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

/** Render a policy map into the YAML/JSON shape the loader reads.
 *  Pure helper — separated from the file-write step so a future
 *  PolicyEngine implementation that doesn't speak the file format
 *  can compose differently. */
export function serializePolicy(policy: Record<string, Permission[]>): string {
  // Lock in the field order so a round-trip-through-this-function
  // is stable diffs in a version-controlled file. Roles sorted
  // alphabetically; grants sorted by (resource, action) inside
  // each role.
  const rolesOut: Record<string, Array<{ resource: string; action: string }>> = {};
  for (const role of Object.keys(policy).sort()) {
    const grants = policy[role] || [];
    const sorted = grants
      .slice()
      .sort((a, b) => (a.resource + ":" + a.action).localeCompare(b.resource + ":" + b.action))
      .map((g) => ({ resource: g.resource, action: g.action }));
    rolesOut[role] = sorted;
  }
  return yaml.dump({ roles: rolesOut }, { sortKeys: false, lineWidth: 100 });
}

/** Atomic write of the policy file. Same tmp+rename pattern used by
 *  products + users — a crash mid-write leaves the previous file
 *  intact. mode 0o600 so the on-disk RBAC catalogue isn't
 *  world-readable on multi-tenant hosts. */
export async function writePolicyFile(
  path: string,
  policy: Record<string, Permission[]>,
): Promise<void> {
  // Validate via the parse path before writing — a bad input
  // shape would otherwise produce a file the boot loader then
  // rejects (fail-closed reboot). Validate-then-write keeps the
  // good-policy invariant.
  loadPolicyFromString(serializePolicy(policy), "(in-memory)");
  const { writeFile, rename } = await import("node:fs/promises");
  const text = serializePolicy(policy);
  const tmp = path + ".tmp";
  await writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}
