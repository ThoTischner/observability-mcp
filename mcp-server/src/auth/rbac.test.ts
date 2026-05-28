import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hasPermission,
  buildRequirePermission,
  listGrantedPermissions,
  DEFAULT_POLICY,
  type Permission,
} from "./rbac.js";
import type { AuthedRequest, AuthRuntime } from "./middleware.js";

function mkReq(roles?: string[]) {
  return {
    session: roles
      ? { sub: "u", name: "u", roles, iat: 0, exp: Date.now() / 1000 + 60 }
      : undefined,
  } as AuthedRequest;
}
function mkRes() {
  let statusCode = 0;
  let body: unknown = null;
  return {
    status(c: number) { statusCode = c; return this; },
    json(b: unknown) { body = b; return this; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  } as unknown as import("express").Response & { statusCode: number; body: unknown };
}

test("DEFAULT_POLICY — viewer reads but cannot write", () => {
  assert.equal(hasPermission(["viewer"], "sources", "read"), true);
  assert.equal(hasPermission(["viewer"], "sources", "write"), false);
  assert.equal(hasPermission(["viewer"], "sources", "delete"), false);
});

test("DEFAULT_POLICY — operator writes sources + settings but never deletes", () => {
  assert.equal(hasPermission(["operator"], "sources", "write"), true);
  assert.equal(hasPermission(["operator"], "settings", "write"), true);
  assert.equal(hasPermission(["operator"], "sources", "delete"), false);
});

test("DEFAULT_POLICY — admin can do everything across every resource", () => {
  for (const resource of ["sources", "services", "health", "topology", "settings", "connectors", "audit", "users"] as const) {
    for (const action of ["read", "write", "delete"] as const) {
      assert.equal(hasPermission(["admin"], resource, action), true, `admin should ${action} ${resource}`);
    }
  }
});

test("hasPermission — empty / missing roles grant nothing", () => {
  assert.equal(hasPermission(undefined, "sources", "read"), false);
  assert.equal(hasPermission([], "sources", "read"), false);
  assert.equal(hasPermission(["unknown-role"], "sources", "read"), false);
});

test("hasPermission — union of roles is honoured", () => {
  // A user assigned both viewer and operator gets the operator superset.
  assert.equal(hasPermission(["viewer", "operator"], "sources", "write"), true);
});

test("hasPermission — custom policy overrides built-in", () => {
  const custom: Record<string, Permission[]> = {
    "incident-commander": [{ resource: "sources", action: "delete" }],
  };
  assert.equal(hasPermission(["incident-commander"], "sources", "delete", custom), true);
  // Built-in admin is NOT in the custom policy → loses its grants.
  assert.equal(hasPermission(["admin"], "sources", "delete", custom), false);
});

test("buildRequirePermission — anonymous always allows", () => {
  const mw = buildRequirePermission({ mode: "anonymous" } as AuthRuntime, "sources", "write");
  const res = mkRes() as ReturnType<typeof mkRes>;
  let called = false;
  mw(mkReq(), res as unknown as import("express").Response, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.statusCode, 0);
});

test("buildRequirePermission — denies viewer on write", () => {
  const runtime = { mode: "basic", session: { secret: "x".repeat(48) } } as AuthRuntime;
  const mw = buildRequirePermission(runtime, "sources", "write");
  const res = mkRes() as ReturnType<typeof mkRes>;
  let called = false;
  mw(mkReq(["viewer"]), res as unknown as import("express").Response, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.code, "OMCP_PERMISSION_DENIED");
});

test("buildRequirePermission — allows operator on write", () => {
  const runtime = { mode: "basic", session: { secret: "x".repeat(48) } } as AuthRuntime;
  const mw = buildRequirePermission(runtime, "sources", "write");
  const res = mkRes() as ReturnType<typeof mkRes>;
  let called = false;
  mw(mkReq(["operator"]), res as unknown as import("express").Response, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.statusCode, 0);
});

test("buildRequirePermission — denies missing session in basic mode", () => {
  const runtime = { mode: "basic", session: { secret: "x".repeat(48) } } as AuthRuntime;
  const mw = buildRequirePermission(runtime, "sources", "read");
  const res = mkRes() as ReturnType<typeof mkRes>;
  let called = false;
  mw(mkReq(), res as unknown as import("express").Response, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

test("listGrantedPermissions — deduplicates across overlapping roles", () => {
  const p = listGrantedPermissions(["viewer", "operator"]);
  const keys = p.map((g) => `${g.resource}:${g.action}`);
  assert.equal(new Set(keys).size, keys.length, "expected no duplicates");
  // sanity: includes both a viewer-only read and an operator-only write
  assert.ok(p.some((g) => g.resource === "sources" && g.action === "read"));
  assert.ok(p.some((g) => g.resource === "sources" && g.action === "write"));
});

test("listGrantedPermissions — admin lists every (resource, action) once", () => {
  const p = listGrantedPermissions(["admin"]);
  // 8 resources * 3 actions = 24 unique entries
  assert.equal(p.length, 24);
});

test("DEFAULT_POLICY shape — has the three built-in roles", () => {
  assert.ok(DEFAULT_POLICY.viewer);
  assert.ok(DEFAULT_POLICY.operator);
  assert.ok(DEFAULT_POLICY.admin);
});
