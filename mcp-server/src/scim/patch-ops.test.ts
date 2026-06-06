import { test } from "node:test";
import assert from "node:assert/strict";

import { applyPatchOps } from "./routes.js";
import type { ScimGroup, ScimPatchRequest } from "./types.js";

function group(members: Array<{ value: string; display?: string }> = []): ScimGroup {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
    id: "g1",
    displayName: "team",
    members,
    meta: { resourceType: "Group", created: "2026-06-06T00:00:00Z", lastModified: "2026-06-06T00:00:00Z" },
  };
}

function patch(...ops: ScimPatchRequest["Operations"]): ScimPatchRequest {
  return { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: ops };
}

// --- replace (existing behaviour preserved) --------------------------

test("replace with no path merges allow-listed keys", () => {
  const out = applyPatchOps(group(), patch({ op: "replace", value: { displayName: "renamed", externalId: "x" } }));
  assert.equal(out.displayName, "renamed");
  assert.equal((out as Record<string, unknown>).externalId, "x");
});

test("replace with path sets that attribute", () => {
  const out = applyPatchOps(group(), patch({ op: "replace", path: "displayName", value: "n2" }));
  assert.equal(out.displayName, "n2");
});

test("replace drops non-allowlisted keys (proto-pollution guard)", () => {
  const out = applyPatchOps(group(), patch({ op: "replace", value: { __proto__: { polluted: true }, constructor: 1, displayName: "ok" } }));
  assert.equal(out.displayName, "ok");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "__proto__"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "constructor"), false);
});

// --- add members -----------------------------------------------------

test("add appends a member to an empty group", () => {
  const out = applyPatchOps(group(), patch({ op: "add", path: "members", value: [{ value: "u1", display: "Alice" }] }));
  assert.deepEqual(out.members, [{ value: "u1", display: "Alice" }]);
});

test("add appends to existing members and dedups by value", () => {
  const out = applyPatchOps(
    group([{ value: "u1" }]),
    patch({ op: "add", path: "members", value: [{ value: "u1" }, { value: "u2" }] }),
  );
  assert.deepEqual((out.members as Array<{ value: string }>).map((m) => m.value), ["u1", "u2"]);
});

test("add accepts a single (non-array) value", () => {
  const out = applyPatchOps(group([{ value: "u1" }]), patch({ op: "add", path: "members", value: { value: "u2" } }));
  assert.deepEqual((out.members as Array<{ value: string }>).map((m) => m.value), ["u1", "u2"]);
});

test("pathless add appends array attrs + sets scalars", () => {
  const out = applyPatchOps(
    group([{ value: "u1" }]),
    patch({ op: "add", value: { members: [{ value: "u2" }], displayName: "renamed" } }),
  );
  assert.deepEqual((out.members as Array<{ value: string }>).map((m) => m.value), ["u1", "u2"]);
  assert.equal(out.displayName, "renamed");
});

// --- remove members --------------------------------------------------

test("remove with a filter drops the matching member", () => {
  const out = applyPatchOps(
    group([{ value: "u1" }, { value: "u2" }, { value: "u3" }]),
    patch({ op: "remove", path: 'members[value eq "u2"]' }),
  );
  assert.deepEqual((out.members as Array<{ value: string }>).map((m) => m.value), ["u1", "u3"]);
});

test("remove with a non-matching filter is a no-op on contents", () => {
  const out = applyPatchOps(
    group([{ value: "u1" }]),
    patch({ op: "remove", path: 'members[value eq "ghost"]' }),
  );
  assert.deepEqual((out.members as Array<{ value: string }>).map((m) => m.value), ["u1"]);
});

test("remove of the whole members attr clears it", () => {
  const out = applyPatchOps(group([{ value: "u1" }, { value: "u2" }]), patch({ op: "remove", path: "members" }));
  assert.deepEqual(out.members, []);
});

// --- chained ops in one request (Entra-style) ------------------------

test("add then remove in one request compose against the working value", () => {
  const out = applyPatchOps(
    group([{ value: "u1" }]),
    patch(
      { op: "add", path: "members", value: [{ value: "u2" }, { value: "u3" }] },
      { op: "remove", path: 'members[value eq "u1"]' },
    ),
  );
  assert.deepEqual((out.members as Array<{ value: string }>).map((m) => m.value), ["u2", "u3"]);
});

// --- security: filtered paths can't pollute --------------------------

test("crafted __proto__ filter path is rejected (fail-closed no-op), no pollution", () => {
  const out = applyPatchOps(
    group([{ value: "u1" }]),
    patch({ op: "remove", path: 'members[__proto__ eq "x"]' }),
  );
  // The sub-attribute regex requires a leading letter, so this path
  // doesn't parse as a filter and isn't a bare allow-listed attr —
  // the op is skipped entirely. No members key is emitted (no change)
  // and nothing is polluted.
  assert.equal(Object.prototype.hasOwnProperty.call(out, "members"), false);
  assert.equal(({} as Record<string, unknown>).x, undefined);
});

test("add to a non-allowlisted path is ignored", () => {
  const out = applyPatchOps(group(), patch({ op: "add", path: "__proto__", value: { polluted: true } }));
  assert.equal(Object.keys(out).length, 0);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

// --- emails array (same machinery) -----------------------------------

test("add + remove works on emails too", () => {
  const user = {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: "u1",
    userName: "a@x",
    emails: [{ value: "a@x", primary: true }],
    meta: { resourceType: "User" as const, created: "2026-06-06T00:00:00Z", lastModified: "2026-06-06T00:00:00Z" },
  };
  const added = applyPatchOps(user, patch({ op: "add", path: "emails", value: [{ value: "a2@x" }] }));
  assert.deepEqual((added.emails as Array<{ value: string }>).map((e) => e.value), ["a@x", "a2@x"]);
  const removed = applyPatchOps(user, patch({ op: "remove", path: 'emails[value eq "a@x"]' }));
  assert.deepEqual((removed.emails as Array<{ value: string }>).map((e) => e.value), []);
});

test("missing target resource throws", () => {
  assert.throws(() => applyPatchOps(undefined, patch({ op: "add", path: "members", value: [] })), /not found/);
});
