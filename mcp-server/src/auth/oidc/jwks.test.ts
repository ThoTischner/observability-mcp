import { test } from "node:test";
import assert from "node:assert/strict";

import { JwksClient } from "./jwks.js";

const jwks1 = { keys: [{ kty: "RSA", kid: "k-1", n: "abc", e: "AQAB" }] };
const jwks12 = { keys: [
  { kty: "RSA", kid: "k-1", n: "abc", e: "AQAB" },
  { kty: "RSA", kid: "k-2", n: "def", e: "AQAB" },
] };

test("JwksClient.get — fetches and caches", async () => {
  let calls = 0;
  const client = new JwksClient({
    fetcher: async () => { calls++; return new Response(JSON.stringify(jwks1), { status: 200 }); },
    ttlMs: 60_000,
  });
  await client.get("https://idp.test/jwks");
  await client.get("https://idp.test/jwks");
  assert.equal(calls, 1);
});

test("JwksClient.findKey — returns key by kid on first try", async () => {
  const client = new JwksClient({ fetcher: async () => new Response(JSON.stringify(jwks12), { status: 200 }) });
  const key = await client.findKey("https://idp.test/jwks", "k-2");
  assert.equal(key?.kid, "k-2");
});

test("JwksClient.findKey — refreshes once on unknown kid (key rotation)", async () => {
  let calls = 0;
  const responses = [jwks1, jwks12]; // First response missing k-2, second has it.
  const client = new JwksClient({
    fetcher: async () => { const body = responses[Math.min(calls, responses.length - 1)]; calls++; return new Response(JSON.stringify(body), { status: 200 }); },
    refreshCooldownMs: 0,
  });
  const key = await client.findKey("https://idp.test/jwks", "k-2");
  assert.equal(calls, 2, "expected one forced refresh after cache miss");
  assert.equal(key?.kid, "k-2");
});

test("JwksClient.findKey — respects refresh cooldown on repeated misses", async () => {
  let calls = 0;
  let now = 1_000_000;
  const client = new JwksClient({
    fetcher: async () => { calls++; return new Response(JSON.stringify(jwks1), { status: 200 }); },
    refreshCooldownMs: 60_000,
    now: () => now,
  });
  // First miss → fetch + forced refresh = 2 calls
  await client.findKey("https://idp.test/jwks", "k-unknown");
  assert.equal(calls, 2);
  // Same miss inside cooldown → no further fetch
  await client.findKey("https://idp.test/jwks", "k-unknown");
  assert.equal(calls, 2);
  // After cooldown expires, one more forced refresh
  now += 61_000;
  await client.findKey("https://idp.test/jwks", "k-unknown");
  assert.equal(calls, 3);
});

test("JwksClient.get — rejects malformed JWKS body", async () => {
  const client = new JwksClient({
    fetcher: async () => new Response(JSON.stringify({ not: "a jwks" }), { status: 200 }),
  });
  await assert.rejects(client.get("https://idp.test/jwks"), /not a valid JWKS/);
});

test("JwksClient.get — rejects HTTP failure", async () => {
  const client = new JwksClient({
    fetcher: async () => new Response("nope", { status: 500 }),
  });
  await assert.rejects(client.get("https://idp.test/jwks"), /HTTP 500/);
});
