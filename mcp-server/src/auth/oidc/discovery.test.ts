import { test } from "node:test";
import assert from "node:assert/strict";

import { DiscoveryClient, type DiscoveryDocument } from "./discovery.js";

function mockFetch(map: Record<string, { status: number; body: unknown }>) {
  return async (url: string) => {
    const r = map[url];
    if (!r) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  };
}

const happyDoc: DiscoveryDocument = {
  issuer: "https://idp.test",
  authorization_endpoint: "https://idp.test/auth",
  token_endpoint: "https://idp.test/token",
  jwks_uri: "https://idp.test/jwks",
};

test("DiscoveryClient — fetches and returns the doc", async () => {
  const client = new DiscoveryClient({
    fetcher: mockFetch({ "https://idp.test/.well-known/openid-configuration": { status: 200, body: happyDoc } }),
  });
  const d = await client.discover("https://idp.test");
  assert.equal(d.token_endpoint, "https://idp.test/token");
});

test("DiscoveryClient — caches within TTL, refetches after expiry", async () => {
  let calls = 0;
  const fetcher = async (url: string) => {
    calls++;
    return new Response(JSON.stringify(happyDoc), { status: 200 });
  };
  let now = 1_000_000;
  const client = new DiscoveryClient({ fetcher, ttlMs: 5_000, now: () => now });
  await client.discover("https://idp.test");
  await client.discover("https://idp.test");
  assert.equal(calls, 1, "second call within TTL should hit cache");
  now += 6_000;
  await client.discover("https://idp.test");
  assert.equal(calls, 2, "after TTL expiry a fresh fetch should happen");
});

test("DiscoveryClient — rejects HTTP failure", async () => {
  const client = new DiscoveryClient({
    fetcher: mockFetch({ "https://idp.test/.well-known/openid-configuration": { status: 500, body: { error: "boom" } } }),
  });
  await assert.rejects(client.discover("https://idp.test"), /HTTP 500/);
});

test("DiscoveryClient — rejects issuer mismatch (RFC 8414 §3)", async () => {
  const lying = { ...happyDoc, issuer: "https://other.example" };
  const client = new DiscoveryClient({
    fetcher: mockFetch({ "https://idp.test/.well-known/openid-configuration": { status: 200, body: lying } }),
  });
  await assert.rejects(client.discover("https://idp.test"), /issuer mismatch/);
});

test("DiscoveryClient — rejects missing required endpoints", async () => {
  const broken = { issuer: "https://idp.test" };
  const client = new DiscoveryClient({
    fetcher: mockFetch({ "https://idp.test/.well-known/openid-configuration": { status: 200, body: broken } }),
  });
  await assert.rejects(client.discover("https://idp.test"), /missing required endpoints/);
});

test("DiscoveryClient — trailing slash on issuer is normalised", async () => {
  let captured = "";
  const client = new DiscoveryClient({
    fetcher: async (url: string) => { captured = url; return new Response(JSON.stringify({ ...happyDoc, issuer: "https://idp.test/" }), { status: 200 }); },
  });
  // Caller passes issuer with trailing slash; URL should still be canonical.
  await client.discover("https://idp.test/");
  assert.equal(captured, "https://idp.test/.well-known/openid-configuration");
});
