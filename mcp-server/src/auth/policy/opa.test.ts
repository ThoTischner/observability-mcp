import { test } from "node:test";
import assert from "node:assert/strict";

import { OpaPolicyEngine } from "./opa.js";

function mockFetcher(handler: (url: string, body: unknown) => unknown): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const result = handler(url, body);
    return new Response(JSON.stringify({ result }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

test("OpaPolicyEngine — evaluate returns warming-deny on first call, real verdict after warm", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    return new Response(JSON.stringify({ result: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const e = new OpaPolicyEngine({ url: "http://opa.test", packagePath: "observability/authz", fetcher });
  // First call: cache miss → conservative deny + async fire.
  const first = e.evaluate(["admin"], "sources", "write");
  assert.equal(first.allowed, false);
  assert.match(first.reason!, /OPA decision pending/);
  // After explicit warm, the cache holds the real verdict.
  const real = await e.warmEvaluate(["admin"], "sources", "write");
  assert.equal(real.allowed, true);
  const cached = e.evaluate(["admin"], "sources", "write");
  assert.equal(cached.allowed, true);
  assert.equal(calls.length, 2, "expected exactly two POSTs: implicit lazy warm + explicit warm");
});

test("OpaPolicyEngine — accepts boolean and rich result shapes", async () => {
  const e1 = new OpaPolicyEngine({ url: "http://opa.test", packagePath: "p", fetcher: mockFetcher(() => true) });
  assert.equal((await e1.warmEvaluate(["admin"], "x", "y")).allowed, true);
  const e2 = new OpaPolicyEngine({
    url: "http://opa.test", packagePath: "p",
    fetcher: mockFetcher(() => ({ allowed: false, reason: "blocked: not in office hours" })),
  });
  const r = await e2.warmEvaluate(["admin"], "x", "y");
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /office hours/);
});

test("OpaPolicyEngine — unrecognised shape denies with a clear reason", async () => {
  const e = new OpaPolicyEngine({ url: "http://opa.test", packagePath: "p", fetcher: mockFetcher(() => 42) });
  const r = await e.warmEvaluate(["admin"], "x", "y");
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /unrecognised result shape/);
});

test("OpaPolicyEngine — http error caches a denial briefly so flapping OPA doesn't hammer", async () => {
  let calls = 0;
  const fetcher = (async (_u: string) => {
    calls++;
    return new Response("nope", { status: 503 });
  }) as unknown as typeof fetch;
  const e = new OpaPolicyEngine({ url: "http://opa.test", packagePath: "p", fetcher });
  const r1 = await e.warmEvaluate(["admin"], "x", "y");
  assert.equal(r1.allowed, false);
  assert.match(r1.reason!, /HTTP 503/);
  // The next sync evaluate within ~1s uses the cached denial.
  const r2 = e.evaluate(["admin"], "x", "y");
  assert.equal(r2.allowed, false);
  assert.equal(calls, 1);
});

test("OpaPolicyEngine — list extracts permissions from the rich shape", async () => {
  const fetcher = mockFetcher((_url, body) => {
    if ((body as { input?: { list?: boolean } })?.input?.list) {
      return { permissions: [{ resource: "sources", action: "read" }, { resource: "sources", action: "write" }] };
    }
    return false;
  });
  const e = new OpaPolicyEngine({ url: "http://opa.test", packagePath: "p", fetcher });
  const perms = await e.warmList(["admin"]);
  assert.equal(perms.length, 2);
  assert.deepEqual(perms[0], { resource: "sources", action: "read" });
});

test("OpaPolicyEngine — list returns [] when OPA returns plain boolean (no permissions key)", async () => {
  const fetcher = mockFetcher(() => true);
  const e = new OpaPolicyEngine({ url: "http://opa.test", packagePath: "p", fetcher });
  const perms = await e.warmList(["admin"]);
  assert.deepEqual(perms, []);
});

test("OpaPolicyEngine — roles() reflects declaredRoles", () => {
  const e = new OpaPolicyEngine({
    url: "http://opa.test", packagePath: "p",
    declaredRoles: ["admin", "operator", "auditor"],
  });
  assert.deepEqual(e.roles(), ["admin", "operator", "auditor"]);
});

test("OpaPolicyEngine — kind() prefixes URL", () => {
  const e = new OpaPolicyEngine({ url: "http://opa.example:8181", packagePath: "p" });
  assert.equal(e.kind(), "opa:http://opa.example:8181");
});

test("OpaPolicyEngine — sends Bearer token when configured", async () => {
  let seenAuth: string | undefined;
  const fetcher = (async (_url: string, init?: RequestInit) => {
    seenAuth = (init?.headers as Record<string, string> | undefined)?.authorization;
    return new Response(JSON.stringify({ result: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const e = new OpaPolicyEngine({ url: "http://opa.test", packagePath: "p", bearerToken: "shh", fetcher });
  await e.warmEvaluate(["admin"], "x", "y");
  assert.equal(seenAuth, "Bearer shh");
});

test("OpaPolicyEngine — cache key delimiter prevents role-name collision (\"a,b\" vs [\"a\",\"b\"])", async () => {
  const calls: Array<unknown> = [];
  const fetcher = (async (_url: string, init?: RequestInit) => {
    calls.push(init?.body ? JSON.parse(String(init.body)) : null);
    // Two distinct results so we can prove no cross-cache-hit.
    return new Response(JSON.stringify({ result: calls.length === 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  const e = new OpaPolicyEngine({ url: "http://opa.test", packagePath: "p", fetcher });
  const r1 = await e.warmEvaluate(["a,b"], "x", "y");
  const r2 = await e.warmEvaluate(["a", "b"], "x", "y");
  assert.equal(r1.allowed, true);
  assert.equal(r2.allowed, false);
  assert.equal(calls.length, 2, "the two role-sets must not collide on the cache key");
});

test("OpaPolicyEngine — sort-stable cache key (role-set order doesn't matter)", async () => {
  let calls = 0;
  const fetcher = (async (_u: string) => {
    calls++;
    return new Response(JSON.stringify({ result: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const e = new OpaPolicyEngine({ url: "http://opa.test", packagePath: "p", fetcher });
  await e.warmEvaluate(["b", "a", "c"], "x", "y");
  // Same role-set in different order → same cache key → no additional fetch
  await e.warmEvaluate(["c", "b", "a"], "x", "y");
  assert.equal(calls, 1);
});
