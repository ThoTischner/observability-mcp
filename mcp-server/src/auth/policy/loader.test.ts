import { test } from "node:test";
import assert from "node:assert/strict";

import { writePolicyFile, loadPolicyFromFile, loadPolicyFromString, serializePolicy, VALID_RESOURCES } from "./loader.js";
import { BuiltinPolicyEngine } from "./engine.js";

test("VALID_RESOURCES — includes products (closes a pre-existing inconsistency vs rbac.ts)", () => {
  assert.ok(VALID_RESOURCES.has("products"), "products must be a recognised resource for file-loaded policies");
});

test("serializePolicy — round-trips through the parser cleanly", () => {
  const text = serializePolicy({
    admin: [
      { resource: "sources", action: "delete" },
      { resource: "users", action: "delete" },
    ],
    viewer: [{ resource: "sources", action: "read" }],
  });
  // Parsing the serialised text via loadPolicyFromString must yield
  // an engine with the same role grants — round-trip is stable.
  const e = loadPolicyFromString(text, "test");
  assert.deepEqual(e.roles().sort(), ["admin", "viewer"]);
  const admin = e.list(["admin"]).map((p) => p.resource + ":" + p.action).sort();
  assert.deepEqual(admin, ["sources:delete", "users:delete"]);
});

test("serializePolicy — deterministic ordering (roles + grants both sorted)", () => {
  const a = serializePolicy({
    z: [{ resource: "sources", action: "write" }, { resource: "audit", action: "read" }],
    a: [{ resource: "users", action: "read" }],
  });
  const b = serializePolicy({
    a: [{ resource: "users", action: "read" }],
    z: [{ resource: "audit", action: "read" }, { resource: "sources", action: "write" }],
  });
  // Same logical policy → byte-identical text. Important for git-diff sanity.
  assert.equal(a, b);
});

test("writePolicyFile — atomic round-trip preserves shape", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "omcp-policy-"));
  try {
    const path = join(dir, "policy.yaml");
    await writePolicyFile(path, {
      admin: [{ resource: "sources", action: "delete" }],
      operator: [{ resource: "sources", action: "write" }],
    });
    const engine = loadPolicyFromFile(path);
    assert.deepEqual(engine.roles().sort(), ["admin", "operator"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writePolicyFile — rejects an invalid resource before writing the file", async () => {
  const { mkdtemp, rm, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "omcp-policy-reject-"));
  try {
    const path = join(dir, "policy.yaml");
    await assert.rejects(
      writePolicyFile(path, {
        admin: [{ resource: "nope" as never, action: "read" as never }],
      }),
      /unknown/i,
    );
    // No file (or tmp) was created — validate-then-write held.
    const entries = await readdir(dir);
    assert.deepEqual(entries, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("BuiltinPolicyEngine.replace — mutates the inner map in place (gate closures see the new policy)", () => {
  const engine = new BuiltinPolicyEngine({
    admin: [{ resource: "sources", action: "delete" }],
  });
  // Capture a reference to the raw map BEFORE replace — verify the
  // reference is preserved (hot-swap, not reassign).
  const before = engine.raw();
  engine.replace({
    admin: [{ resource: "sources", action: "delete" }, { resource: "audit", action: "read" }],
    viewer: [{ resource: "sources", action: "read" }],
  });
  assert.equal(before, engine.raw(), "raw() must return the same object reference after replace()");
  assert.deepEqual(engine.roles().sort(), ["admin", "viewer"]);
  assert.equal(engine.evaluate(["admin"], "audit", "read").allowed, true);
  assert.equal(engine.evaluate(["viewer"], "sources", "read").allowed, true);
});
