import { test } from "node:test";
import assert from "node:assert/strict";

import { RedisScimStore, type RedisLike } from "./redis-store.js";
import { ScimNotFoundError, ScimValidationError } from "./store.js";

/** In-memory fake of the RedisLike surface — single-key GET/SET. */
function fakeRedis(initial?: Record<string, string>): RedisLike & { _store: Map<string, string>; _writeCount: number } {
  const store = new Map<string, string>(Object.entries(initial || {}));
  return {
    _store: store,
    _writeCount: 0,
    async get(key: string) { return store.has(key) ? store.get(key)! : null; },
    async set(key: string, value: string) {
      store.set(key, value);
      (this as { _writeCount: number })._writeCount += 1;
      return "OK";
    },
  };
}

test("load() initialises empty when redis key is missing", async () => {
  const r = fakeRedis();
  const s = new RedisScimStore(r);
  await s.load();
  assert.deepEqual(s.listUsers(), []);
  assert.deepEqual(s.listGroups(), []);
});

test("load() hydrates from a serialised snapshot in redis", async () => {
  const r = fakeRedis({
    "omcp:scim:snapshot": JSON.stringify({
      users: [{ id: "u1", userName: "alice@example.com", schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], meta: { resourceType: "User" } }],
      groups: [],
    }),
  });
  const s = new RedisScimStore(r);
  await s.load();
  assert.equal(s.listUsers().length, 1);
  assert.equal(s.listUsers()[0].userName, "alice@example.com");
});

test("createUser persists to redis", async () => {
  const r = fakeRedis();
  const s = new RedisScimStore(r);
  await s.load();
  const u = await s.createUser({ userName: "bob@example.com" });
  assert.ok(u.id);
  assert.equal(u.userName, "bob@example.com");
  // Persisted snapshot round-trips through redis
  const raw = JSON.parse(r._store.get("omcp:scim:snapshot")!);
  assert.equal(raw.users.length, 1);
  assert.equal(raw.users[0].userName, "bob@example.com");
});

test("createUser enforces unique userName", async () => {
  const r = fakeRedis();
  const s = new RedisScimStore(r);
  await s.load();
  await s.createUser({ userName: "alice@example.com" });
  await assert.rejects(s.createUser({ userName: "alice@example.com" }), ScimValidationError);
});

test("createUser without userName throws", async () => {
  const r = fakeRedis();
  const s = new RedisScimStore(r);
  await s.load();
  await assert.rejects(s.createUser({}), ScimValidationError);
});

test("updateUser preserves id + sets lastModified to a not-earlier ts", async () => {
  const r = fakeRedis();
  const s = new RedisScimStore(r);
  await s.load();
  const u = await s.createUser({ userName: "u@x" });
  // 2ms gap so the ISO timestamp differs even on slow CI clocks
  await new Promise((res) => setTimeout(res, 2));
  const u2 = await s.updateUser(u.id, { displayName: "U" });
  assert.equal(u2.id, u.id);
  assert.equal(u2.displayName, "U");
  assert.ok(u2.meta.lastModified >= u.meta.lastModified);
});

test("updateUser missing throws ScimNotFoundError", async () => {
  const r = fakeRedis();
  const s = new RedisScimStore(r);
  await s.load();
  await assert.rejects(s.updateUser("nope", { displayName: "x" }), ScimNotFoundError);
});

test("deleteUser purges the user from all group member lists", async () => {
  const r = fakeRedis();
  const s = new RedisScimStore(r);
  await s.load();
  const u = await s.createUser({ userName: "u@x" });
  const g = await s.createGroup({ displayName: "admins", members: [{ value: u.id, display: "u@x" }] });
  await s.deleteUser(u.id);
  const updated = s.getGroup(g.id);
  assert.equal(updated?.members?.length, 0);
});

test("group CRUD round-trip persists", async () => {
  const r = fakeRedis();
  const s = new RedisScimStore(r);
  await s.load();
  const g = await s.createGroup({ displayName: "team-alpha" });
  assert.equal(g.displayName, "team-alpha");
  const g2 = await s.updateGroup(g.id, { displayName: "team-beta" });
  assert.equal(g2.displayName, "team-beta");
  assert.equal((await s.deleteGroup(g.id)), true);
  assert.equal((await s.deleteGroup(g.id)), false);
});

test("groupsContaining returns membership", async () => {
  const r = fakeRedis();
  const s = new RedisScimStore(r);
  await s.load();
  const u = await s.createUser({ userName: "u@x" });
  const g = await s.createGroup({ displayName: "admins", members: [{ value: u.id, display: "u@x" }] });
  const groups = s.groupsContaining(u.id);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].value, g.id);
  assert.equal(groups[0].display, "admins");
});

test("custom key is honoured", async () => {
  const r = fakeRedis();
  const s = new RedisScimStore(r, { key: "custom:key" });
  await s.load();
  await s.createUser({ userName: "u@x" });
  assert.ok(r._store.has("custom:key"));
  assert.equal(r._store.has("omcp:scim:snapshot"), false);
});

test("concurrent writes serialise — no lost-write race", async () => {
  const r = fakeRedis();
  const s = new RedisScimStore(r);
  await s.load();
  const u1 = s.createUser({ userName: "a@x" });
  const u2 = s.createUser({ userName: "b@x" });
  const u3 = s.createUser({ userName: "c@x" });
  await Promise.all([u1, u2, u3]);
  const final = JSON.parse(r._store.get("omcp:scim:snapshot")!);
  assert.equal(final.users.length, 3);
});

test("malformed snapshot in redis → starts empty (warning logged)", async () => {
  const r = fakeRedis({ "omcp:scim:snapshot": "this is not json" });
  const s = new RedisScimStore(r);
  await s.load();
  assert.deepEqual(s.listUsers(), []);
  assert.deepEqual(s.listGroups(), []);
});
