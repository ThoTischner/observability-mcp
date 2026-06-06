import { test } from "node:test";
import assert from "node:assert/strict";

import {
  InMemoryTransportSessionMap,
  SessionStoreBackedTransportSessionMap,
  createTransportSessionMap,
  type TransportSessionMeta,
} from "./transportSessionMap.js";
import { InMemorySessionStore, type SessionStore } from "./sessionStore.js";

function meta(p: Partial<TransportSessionMeta> = {}): TransportSessionMeta {
  return {
    ownerReplica: p.ownerReplica ?? "replica-A",
    product: p.product,
    lastActive: p.lastActive ?? Date.now(),
  };
}

test("InMemoryTransportSessionMap: get/set/has/delete round-trip", async () => {
  const m = new InMemoryTransportSessionMap();
  assert.equal(await m.has("s1"), false);
  await m.set("s1", meta({ product: "checkout" }));
  assert.equal(await m.has("s1"), true);
  const got = await m.get("s1");
  assert.equal(got?.ownerReplica, "replica-A");
  assert.equal(got?.product, "checkout");
  await m.delete("s1");
  assert.equal(await m.has("s1"), false);
});

test("InMemoryTransportSessionMap: touch bumps lastActive", async () => {
  const m = new InMemoryTransportSessionMap();
  const before = Date.now() - 10_000;
  await m.set("s1", meta({ lastActive: before }));
  await new Promise((r) => setTimeout(r, 2));
  await m.touch("s1");
  const got = await m.get("s1");
  assert.ok((got?.lastActive ?? 0) > before);
});

test("InMemoryTransportSessionMap: keys + cleanup", async () => {
  const m = new InMemoryTransportSessionMap();
  await m.set("fresh", meta({ lastActive: Date.now() }));
  await m.set("stale", meta({ lastActive: Date.now() - 10_000 }));
  const all = await m.keys();
  assert.equal(all.length, 2);
  const evicted = await m.cleanup(5_000);
  assert.deepEqual(evicted, ["stale"]);
  assert.equal(await m.has("stale"), false);
  assert.equal(await m.has("fresh"), true);
});

test("SessionStoreBackedTransportSessionMap: round-trip via SessionStore", async () => {
  const store = new InMemorySessionStore();
  const m = new SessionStoreBackedTransportSessionMap(store);
  await m.set("s1", meta({ product: "p" }));
  assert.equal(await m.has("s1"), true);
  const got = await m.get("s1");
  assert.equal(got?.product, "p");
  await m.delete("s1");
  assert.equal(await m.has("s1"), false);
});

test("SessionStoreBackedTransportSessionMap: keys excludes the prefix in returned ids", async () => {
  const store = new InMemorySessionStore();
  const m = new SessionStoreBackedTransportSessionMap(store);
  await m.set("alpha", meta());
  await m.set("beta", meta());
  const ids = (await m.keys()).sort();
  assert.deepEqual(ids, ["alpha", "beta"]);
  // Unrelated keys on the same SessionStore must not pollute the map.
  await store.set("scim:user:1", { foo: "bar" });
  const idsAfter = (await m.keys()).sort();
  assert.deepEqual(idsAfter, ["alpha", "beta"]);
});

test("SessionStoreBackedTransportSessionMap: cleanup evicts stale entries", async () => {
  const store = new InMemorySessionStore();
  const m = new SessionStoreBackedTransportSessionMap(store);
  await m.set("fresh", meta({ lastActive: Date.now() }));
  await m.set("stale", meta({ lastActive: Date.now() - 60_000 }));
  const evicted = await m.cleanup(30_000);
  assert.deepEqual(evicted, ["stale"]);
});

test("SessionStoreBackedTransportSessionMap: touch is no-op on missing id", async () => {
  const store = new InMemorySessionStore();
  const m = new SessionStoreBackedTransportSessionMap(store);
  await m.touch("ghost");
  assert.equal(await m.has("ghost"), false);
});

test("SessionStoreBackedTransportSessionMap: backend tag exposes underlying store name", () => {
  const store = new InMemorySessionStore();
  const m = new SessionStoreBackedTransportSessionMap(store);
  assert.equal(m.backend, "session-store:memory");
});

test("createTransportSessionMap: memory backend returns in-memory impl", () => {
  const store = new InMemorySessionStore();
  const m = createTransportSessionMap(store);
  assert.equal(m.backend, "memory");
});

test("createTransportSessionMap: non-memory backend returns wrapper", () => {
  // Fake a non-memory backend by stubbing the backend tag.
  const fake: SessionStore = {
    backend: "redis",
    async get() { return undefined; },
    async set() {},
    async setEx() {},
    async del() {},
    async keys() { return []; },
    async close() {},
  };
  const m = createTransportSessionMap(fake);
  assert.equal(m.backend, "session-store:redis");
});

test("createTransportSessionMap: undefined sessionStore → memory impl (back-compat)", () => {
  const m = createTransportSessionMap();
  assert.equal(m.backend, "memory");
});

test("InMemoryTransportSessionMap.touch: ghost id is no-op", async () => {
  const m = new InMemoryTransportSessionMap();
  await m.touch("ghost");
  assert.equal(await m.has("ghost"), false);
});
