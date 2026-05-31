import { test } from "node:test";
import assert from "node:assert/strict";

import { BuiltinPolicyEngine } from "./engine.js";
import { DEFAULT_POLICY } from "../rbac.js";
import { loadPolicyFromString, PolicyLoadError } from "./loader.js";

test("BuiltinPolicyEngine — evaluate returns allowed for granted perm", () => {
  const e = new BuiltinPolicyEngine(DEFAULT_POLICY);
  const r = e.evaluate(["viewer"], "sources", "read");
  assert.equal(r.allowed, true);
  assert.match(r.reason!, /granted by role viewer/);
});

test("BuiltinPolicyEngine — evaluate returns denied with role context", () => {
  const e = new BuiltinPolicyEngine(DEFAULT_POLICY);
  const r = e.evaluate(["viewer"], "sources", "write");
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /viewer.*do not grant sources:write/);
});

test("BuiltinPolicyEngine — evaluate denies when roles missing / empty", () => {
  const e = new BuiltinPolicyEngine(DEFAULT_POLICY);
  assert.equal(e.evaluate(undefined, "sources", "read").allowed, false);
  assert.equal(e.evaluate([], "sources", "read").allowed, false);
});

test("BuiltinPolicyEngine — list dedupes across overlapping roles", () => {
  const e = new BuiltinPolicyEngine(DEFAULT_POLICY);
  const both = e.list(["viewer", "operator"]);
  // operator inherits viewer's reads; the union shouldn't contain dupes
  const keys = new Set(both.map((p) => p.resource + ":" + p.action));
  assert.equal(keys.size, both.length);
});

test("BuiltinPolicyEngine.roles / kind", () => {
  const e = new BuiltinPolicyEngine(DEFAULT_POLICY);
  assert.deepEqual(e.roles().sort(), ["admin", "operator", "viewer"]);
  assert.equal(e.kind(), "builtin");
});

test("loadPolicyFromString — happy path YAML", () => {
  const yamlText = `
roles:
  viewer:
    - { resource: sources, action: read }
    - { resource: services, action: read }
  custom-bot:
    - { resource: redaction, action: bypass }
`;
  const e = loadPolicyFromString(yamlText, "test");
  assert.equal(e.kind(), "test");
  assert.equal(e.evaluate(["viewer"], "sources", "read").allowed, true);
  assert.equal(e.evaluate(["custom-bot"], "redaction", "bypass").allowed, true);
  assert.equal(e.evaluate(["viewer"], "redaction", "bypass").allowed, false);
});

test("loadPolicyFromString — rejects unknown resource", () => {
  const yamlText = `
roles:
  viewer:
    - { resource: sourcez, action: read }
`;
  assert.throws(() => loadPolicyFromString(yamlText, "t"), /resource 'sourcez' unknown/);
});

test("loadPolicyFromString — rejects unknown action", () => {
  const yamlText = `
roles:
  viewer:
    - { resource: sources, action: peek }
`;
  assert.throws(() => loadPolicyFromString(yamlText, "t"), /action 'peek' unknown/);
});

test("loadPolicyFromString — rejects unexpected key (typo guard)", () => {
  const yamlText = `
roles:
  viewer:
    - { tesource: sources, action: read }
`;
  assert.throws(() => loadPolicyFromString(yamlText, "t"), /unexpected key 'tesource'/);
});

test("loadPolicyFromString — rejects non-object root / missing roles", () => {
  assert.throws(() => loadPolicyFromString("[1,2,3]", "t"), /expected an object/);
  assert.throws(() => loadPolicyFromString("foo: bar", "t"), /missing or non-object 'roles'/);
});

test("loadPolicyFromString — rejects role with non-array grants", () => {
  assert.throws(() => loadPolicyFromString("roles:\n  viewer: 'read-everything'", "t"), /viewer must be a list/);
});

test("loadPolicyFromString — surfaces YAML parse errors with origin", () => {
  // Tab character is invalid YAML indentation.
  assert.throws(() => loadPolicyFromString("\troles:\n\tviewer: []", "my-test"), PolicyLoadError);
});

test("loadPolicyFromString — file-supplied admin REPLACES built-in admin (no merge)", () => {
  // The default admin role gets redaction:bypass. A custom admin that
  // omits it must not silently inherit; otherwise an operator's
  // attempt to lock down the role would be defeated.
  const text = `
roles:
  admin:
    - { resource: sources, action: read }
`;
  const e = loadPolicyFromString(text, "t");
  assert.equal(e.evaluate(["admin"], "sources", "read").allowed, true);
  assert.equal(e.evaluate(["admin"], "redaction", "bypass").allowed, false, "custom admin must NOT inherit redaction:bypass");
  assert.equal(e.evaluate(["admin"], "users", "delete").allowed, false, "custom admin must NOT inherit users:delete");
});
