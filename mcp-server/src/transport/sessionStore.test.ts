import { test } from "node:test";
import assert from "node:assert/strict";

import {
  InMemorySessionStore,
  RedisSessionStore,
  type RedisClientLike,
} from "./sessionStore.js";

test("InMemorySessionStore: backend identifier is 'memory'", () => {
  const s = new InMemorySessionStore();
  assert.equal(s.backend, "memory");
});

test("InMemorySessionStore: set + get round-trips JSON-serialisable values", async () => {
  const s = new InMemorySessionStore();
  await s.set("k", { a: 1, b: ["x", "y"] });
  assert.deepEqual(await s.get("k"), { a: 1, b: ["x", "y"] });
});

test("InMemorySessionStore: missing key returns undefined", async () => {
  const s = new InMemorySessionStore();
  assert.equal(await s.get("nope"), undefined);
});

test("InMemorySessionStore: del removes a key", async () => {
  const s = new InMemorySessionStore();
  await s.set("k", "v");
  await s.del("k");
  assert.equal(await s.get("k"), undefined);
});

test("InMemorySessionStore: setEx expires after ttl", async () => {
  const s = new InMemorySessionStore();
  await s.setEx("k", 0.05, "soon-gone"); // 50ms
  assert.equal(await s.get("k"), "soon-gone");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(await s.get("k"), undefined);
});

test("InMemorySessionStore: keys(prefix) returns matching keys, drops expired ones", async () => {
  const s = new InMemorySessionStore();
  await s.set("oidc:flow:a", 1);
  await s.set("oidc:flow:b", 2);
  await s.set("mcp:session:c", 3);
  await s.setEx("oidc:flow:expired", 0.02, 4);
  await new Promise((r) => setTimeout(r, 50));
  const oidc = await s.keys("oidc:flow:");
  assert.deepEqual(oidc.sort(), ["oidc:flow:a", "oidc:flow:b"]);
  assert.deepEqual(await s.keys("mcp:"), ["mcp:session:c"]);
});

test("InMemorySessionStore: close() clears state", async () => {
  const s = new InMemorySessionStore();
  await s.set("k", 1);
  await s.close();
  assert.equal(await s.get("k"), undefined);
  assert.equal(s.size(), 0);
});

// FakeRedis: tiny in-memory implementation of the RedisClientLike
// surface, lets us test RedisSessionStore without a real broker.
class FakeRedis implements RedisClientLike {
  store = new Map<string, string>();
  quitCalled = false;
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(
    key: string,
    value: string,
    _opts?: { EX?: number },
  ): Promise<string> {
    this.store.set(key, value);
    return "OK";
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
  async keys(pattern: string): Promise<string[]> {
    // FakeRedis only supports prefix*.
    const prefix = pattern.replace(/\*$/, "");
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
  async quit(): Promise<string> {
    this.quitCalled = true;
    return "OK";
  }
}

test("RedisSessionStore: applies prefix on set/get/del/keys", async () => {
  const fake = new FakeRedis();
  const s = new RedisSessionStore(fake, "test:");
  await s.set("k", { hello: "world" });
  assert.ok(fake.store.has("test:k"));
  assert.deepEqual(await s.get("k"), { hello: "world" });
  await s.del("k");
  assert.equal(await s.get("k"), undefined);
});

test("RedisSessionStore: keys() strips the prefix before returning", async () => {
  const fake = new FakeRedis();
  const s = new RedisSessionStore(fake, "test:");
  await s.set("oidc:a", 1);
  await s.set("oidc:b", 2);
  const found = await s.keys("oidc:");
  assert.deepEqual(found.sort(), ["oidc:a", "oidc:b"]);
});

test("RedisSessionStore: setEx forwards EX to the driver", async () => {
  const fake = new FakeRedis();
  let seenOpts: unknown;
  fake.set = async (key, value, opts) => {
    seenOpts = opts;
    fake.store.set(key, value);
    return "OK";
  };
  const s = new RedisSessionStore(fake, "");
  await s.setEx("k", 30, "v");
  assert.deepEqual(seenOpts, { EX: 30 });
});

test("RedisSessionStore: malformed JSON in store returns undefined", async () => {
  const fake = new FakeRedis();
  fake.store.set("test:bad", "not-json{");
  const s = new RedisSessionStore(fake, "test:");
  assert.equal(await s.get("bad"), undefined);
});

test("RedisSessionStore: close() calls quit()", async () => {
  const fake = new FakeRedis();
  const s = new RedisSessionStore(fake, "test:");
  await s.close();
  assert.equal(fake.quitCalled, true);
});

test("RedisSessionStore: backend identifier is 'redis'", () => {
  const fake = new FakeRedis();
  const s = new RedisSessionStore(fake);
  assert.equal(s.backend, "redis");
});
