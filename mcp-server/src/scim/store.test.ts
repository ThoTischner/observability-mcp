import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ScimStore, ScimValidationError, ScimNotFoundError } from "./store.js";

function tmpStore(): string {
  return join(mkdtempSync(join(tmpdir(), "scim-")), "scim.json");
}

test("ScimStore: load() on missing file → empty snapshot", async () => {
  const s = new ScimStore(tmpStore());
  await s.load();
  assert.deepEqual(s.listUsers(), []);
  assert.deepEqual(s.listGroups(), []);
});

test("ScimStore: createUser issues UUID id, sets schemas/meta, active=true default", async () => {
  const s = new ScimStore(tmpStore());
  await s.load();
  const u = await s.createUser({ userName: "alice@example.com" });
  assert.match(u.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(u.schemas, ["urn:ietf:params:scim:schemas:core:2.0:User"]);
  assert.equal(u.userName, "alice@example.com");
  assert.equal(u.active, true);
  assert.equal(u.meta.resourceType, "User");
});

test("ScimStore: createUser rejects duplicate userName with uniqueness scimType", async () => {
  const s = new ScimStore(tmpStore());
  await s.load();
  await s.createUser({ userName: "alice@example.com" });
  await assert.rejects(
    () => s.createUser({ userName: "alice@example.com" }),
    (e: unknown) => e instanceof ScimValidationError && e.scimType === "uniqueness",
  );
});

test("ScimStore: createUser rejects missing userName", async () => {
  const s = new ScimStore(tmpStore());
  await s.load();
  await assert.rejects(() => s.createUser({}), ScimValidationError);
});

test("ScimStore: getUser / getUserByUserName lookups", async () => {
  const s = new ScimStore(tmpStore());
  await s.load();
  const u = await s.createUser({ userName: "alice@example.com" });
  assert.equal(s.getUser(u.id)?.id, u.id);
  assert.equal(s.getUserByUserName("alice@example.com")?.id, u.id);
  assert.equal(s.getUser("nope"), undefined);
});

test("ScimStore: updateUser merges patch + bumps lastModified", async () => {
  const s = new ScimStore(tmpStore());
  await s.load();
  const u = await s.createUser({ userName: "alice@example.com" });
  const created = u.meta.lastModified;
  await new Promise((r) => setTimeout(r, 5));
  const updated = await s.updateUser(u.id, { displayName: "Alice" });
  assert.equal(updated.displayName, "Alice");
  assert.equal(updated.userName, "alice@example.com");
  assert.notEqual(updated.meta.lastModified, created);
});

test("ScimStore: updateUser on missing id throws NotFound", async () => {
  const s = new ScimStore(tmpStore());
  await s.load();
  await assert.rejects(() => s.updateUser("nope", { displayName: "x" }), ScimNotFoundError);
});

test("ScimStore: deleteUser removes user + scrubs them from group members", async () => {
  const s = new ScimStore(tmpStore());
  await s.load();
  const u = await s.createUser({ userName: "alice@example.com" });
  const g = await s.createGroup({
    displayName: "admins",
    members: [{ value: u.id, display: "Alice" }],
  });
  assert.equal(await s.deleteUser(u.id), true);
  assert.equal(s.getUser(u.id), undefined);
  const refreshed = s.getGroup(g.id);
  assert.deepEqual(refreshed?.members, []);
});

test("ScimStore: deleteUser missing → false", async () => {
  const s = new ScimStore(tmpStore());
  await s.load();
  assert.equal(await s.deleteUser("nope"), false);
});

test("ScimStore: createGroup with displayName + member list", async () => {
  const s = new ScimStore(tmpStore());
  await s.load();
  const u = await s.createUser({ userName: "alice@example.com" });
  const g = await s.createGroup({
    displayName: "admins",
    members: [{ value: u.id, display: "Alice" }],
  });
  assert.equal(g.displayName, "admins");
  assert.equal(g.members?.length, 1);
});

test("ScimStore: groupsContaining(userId) returns the groups a user is in", async () => {
  const s = new ScimStore(tmpStore());
  await s.load();
  const u = await s.createUser({ userName: "alice@example.com" });
  await s.createGroup({ displayName: "admins", members: [{ value: u.id }] });
  await s.createGroup({ displayName: "viewers", members: [{ value: u.id }] });
  await s.createGroup({ displayName: "irrelevant", members: [] });
  const got = s.groupsContaining(u.id);
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((g) => g.display).sort(), ["admins", "viewers"]);
});

test("ScimStore: persists to disk with mode 0o600 (atomic tmp+rename)", async () => {
  const path = tmpStore();
  const s = new ScimStore(path);
  await s.load();
  await s.createUser({ userName: "alice@example.com" });
  assert.ok(existsSync(path));
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600, `mode 0${mode.toString(8)} != 0600`);
});

test("ScimStore: round-trip through disk (load after persist sees the entries)", async () => {
  const path = tmpStore();
  const a = new ScimStore(path);
  await a.load();
  await a.createUser({ userName: "alice@example.com" });
  await a.createGroup({ displayName: "admins", members: [{ value: a.listUsers()[0].id }] });

  const b = new ScimStore(path);
  await b.load();
  assert.equal(b.listUsers().length, 1);
  assert.equal(b.listGroups().length, 1);
  assert.equal(b.listUsers()[0].userName, "alice@example.com");
});
