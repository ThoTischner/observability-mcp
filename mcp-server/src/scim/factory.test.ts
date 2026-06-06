import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createScimStore, ScimStore } from "./store.js";
import { RedisScimStore } from "./redis-store.js";

function tmpStorePath() {
  return join(mkdtempSync(join(tmpdir(), "omcp-scim-factory-")), "scim.json");
}

test("createScimStore default = file backend", async () => {
  const path = tmpStorePath();
  delete process.env.OMCP_SCIM_BACKEND;
  const store = await createScimStore({ path });
  assert.ok(store instanceof ScimStore);
  // The store is usable
  const u = await store.createUser({ userName: "a@x" });
  assert.equal(u.userName, "a@x");
});

test("createScimStore explicit backend=file", async () => {
  const store = await createScimStore({ backend: "file", path: tmpStorePath() });
  assert.ok(store instanceof ScimStore);
});

test("createScimStore backend=redis requires a client", async () => {
  await assert.rejects(
    createScimStore({ backend: "redis" }),
    /backend=redis requires a redis client/,
  );
});

test("createScimStore backend=redis returns RedisScimStore", async () => {
  const fake = {
    _s: new Map<string, string>(),
    async get(k: string) { return this._s.has(k) ? this._s.get(k)! : null; },
    async set(k: string, v: string) { this._s.set(k, v); return "OK"; },
  };
  const store = await createScimStore({ backend: "redis", redis: fake });
  assert.ok(store instanceof RedisScimStore);
  const u = await store.createUser({ userName: "u@x" });
  assert.equal(u.userName, "u@x");
  // Persisted to the fake redis
  assert.ok(fake._s.has("omcp:scim:snapshot"));
});

test("createScimStore reads OMCP_SCIM_BACKEND env when no explicit backend", async () => {
  process.env.OMCP_SCIM_BACKEND = "redis";
  try {
    const fake = {
      _s: new Map<string, string>(),
      async get(k: string) { return this._s.get(k) ?? null; },
      async set(k: string, v: string) { this._s.set(k, v); return "OK"; },
    };
    const store = await createScimStore({ redis: fake });
    assert.ok(store instanceof RedisScimStore);
  } finally {
    delete process.env.OMCP_SCIM_BACKEND;
  }
});
