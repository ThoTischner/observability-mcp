import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey, createSign } from "node:crypto";

import { OidcClient } from "./client.js";
import type { Jwk } from "./jwt.js";

function b64u(s: string | Buffer): string {
  const b = typeof s === "string" ? Buffer.from(s, "utf8") : s;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signRs256(payload: Record<string, unknown>, privateKey: import("node:crypto").KeyObject, kid: string): string {
  const header = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const body = b64u(JSON.stringify(payload));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  signer.end();
  return `${header}.${body}.${b64u(signer.sign(privateKey))}`;
}

function rsaKey(): { jwk: Jwk; privateKey: import("node:crypto").KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = createPublicKey(publicKey).export({ format: "jwk" }) as Jwk;
  jwk.kid = "test-kid";
  return { jwk, privateKey };
}

function makeFetcher(handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  return async (url: string, init?: RequestInit) => {
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url === pattern) return Promise.resolve(handler(init));
    }
    return new Response("not found", { status: 404 });
  };
}

const ISSUER = "https://idp.test";
const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/auth`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
};

test("OidcClient.start — builds authorize URL with PKCE + nonce + state", async () => {
  const fetcher = makeFetcher({
    [`${ISSUER}/.well-known/openid-configuration`]: () => new Response(JSON.stringify(DISCOVERY), { status: 200 }),
  });
  const client = new OidcClient({ issuer: ISSUER, clientId: "c-1", redirectUri: "https://app.test/cb", fetcher });
  const r = await client.start();
  const u = new URL(r.authorizeUrl);
  assert.equal(u.origin + u.pathname, `${ISSUER}/auth`);
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("client_id"), "c-1");
  assert.equal(u.searchParams.get("redirect_uri"), "https://app.test/cb");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.ok(u.searchParams.get("code_challenge"));
  assert.equal(u.searchParams.get("state"), r.flow.state);
  assert.equal(u.searchParams.get("nonce"), r.flow.nonce);
  assert.ok(r.flow.codeVerifier.length >= 43);
});

test("OidcClient.complete — verifies state, exchanges code, verifies id_token", async () => {
  const { jwk, privateKey } = rsaKey();
  const now = 1_700_000_000;
  const flow = { state: "S", nonce: "N", codeVerifier: "V_43charsminimum_______________________________________________" };
  const idToken = signRs256({ iss: ISSUER, aud: "c-1", sub: "alice", exp: now + 60, iat: now, nonce: "N" }, privateKey, jwk.kid!);
  const fetcher = makeFetcher({
    [`${ISSUER}/.well-known/openid-configuration`]: () => new Response(JSON.stringify(DISCOVERY), { status: 200 }),
    [`${ISSUER}/jwks`]: () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }),
    [`${ISSUER}/token`]: () => new Response(JSON.stringify({ id_token: idToken, access_token: "AT" }), { status: 200 }),
  });
  const client = new OidcClient({ issuer: ISSUER, clientId: "c-1", redirectUri: "https://app.test/cb", fetcher, now: () => now * 1000 });
  const r = await client.complete({ code: "ABC", state: "S", flow });
  assert.equal(r.claims.sub, "alice");
  assert.equal(r.accessToken, "AT");
});

test("OidcClient.complete — rejects state mismatch", async () => {
  const fetcher = makeFetcher({
    [`${ISSUER}/.well-known/openid-configuration`]: () => new Response(JSON.stringify(DISCOVERY), { status: 200 }),
  });
  const client = new OidcClient({ issuer: ISSUER, clientId: "c-1", redirectUri: "https://app.test/cb", fetcher });
  await assert.rejects(
    client.complete({ code: "x", state: "wrong", flow: { state: "real", nonce: "n", codeVerifier: "v" } }),
    /state mismatch/,
  );
});

test("OidcClient.complete — surfaces token-endpoint failures", async () => {
  const fetcher = makeFetcher({
    [`${ISSUER}/.well-known/openid-configuration`]: () => new Response(JSON.stringify(DISCOVERY), { status: 200 }),
    [`${ISSUER}/token`]: () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
  });
  const client = new OidcClient({ issuer: ISSUER, clientId: "c-1", redirectUri: "https://app.test/cb", fetcher });
  await assert.rejects(
    client.complete({ code: "x", state: "S", flow: { state: "S", nonce: "n", codeVerifier: "v" } }),
    /HTTP 400/,
  );
});

test("OidcClient.complete — rejects missing id_token in token response", async () => {
  const fetcher = makeFetcher({
    [`${ISSUER}/.well-known/openid-configuration`]: () => new Response(JSON.stringify(DISCOVERY), { status: 200 }),
    [`${ISSUER}/token`]: () => new Response(JSON.stringify({ access_token: "AT" }), { status: 200 }),
  });
  const client = new OidcClient({ issuer: ISSUER, clientId: "c-1", redirectUri: "https://app.test/cb", fetcher });
  await assert.rejects(
    client.complete({ code: "x", state: "S", flow: { state: "S", nonce: "n", codeVerifier: "v" } }),
    /missing id_token/,
  );
});

test("OidcClient.complete — uses Basic auth when clientSecret set", async () => {
  const { jwk, privateKey } = rsaKey();
  const now = 1_700_000_000;
  const idToken = signRs256({ iss: ISSUER, aud: "c-1", sub: "alice", exp: now + 60, iat: now, nonce: "n" }, privateKey, jwk.kid!);
  let captured: string | undefined;
  const fetcher = async (url: string, init?: RequestInit) => {
    if (url === `${ISSUER}/.well-known/openid-configuration`) return new Response(JSON.stringify(DISCOVERY), { status: 200 });
    if (url === `${ISSUER}/jwks`) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    if (url === `${ISSUER}/token`) {
      captured = (init?.headers as Record<string, string>).authorization;
      return new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
    }
    return new Response("nf", { status: 404 });
  };
  const client = new OidcClient({ issuer: ISSUER, clientId: "c-1", clientSecret: "shh", redirectUri: "https://app.test/cb", fetcher, now: () => now * 1000 });
  await client.complete({ code: "x", state: "S", flow: { state: "S", nonce: "n", codeVerifier: "v" } });
  assert.ok(captured?.startsWith("Basic "));
  const decoded = Buffer.from(captured!.slice("Basic ".length), "base64").toString();
  assert.equal(decoded, "c-1:shh");
});
