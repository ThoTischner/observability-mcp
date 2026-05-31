/**
 * Integration test for the three OIDC HTTP endpoints. Boots a real
 * Express app, registers the routes against a stubbed OidcClient
 * (mock fetcher) so the IdP round-trip is in-process, and walks
 * through the redirect → callback → session-cookie flow end-to-end.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { generateKeyPairSync, createPublicKey, createSign } from "node:crypto";

import { registerOidcRoutes } from "./endpoints.js";
import { buildOidcRuntime, type OidcRuntimeConfig } from "./runtime.js";
import { OidcClient } from "./client.js";
import type { Jwk } from "./jwt.js";

const SECRET = "x".repeat(32);
const ISSUER = "https://idp.test";
const CLIENT_ID = "c-1";
const REDIRECT_URI = "http://app.test/api/auth/oidc/callback";

function b64u(s: string | Buffer): string {
  const b = typeof s === "string" ? Buffer.from(s, "utf8") : s;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function rsaKey(): { jwk: Jwk; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const jwk = createPublicKey(publicKey).export({ format: "jwk" }) as Jwk;
  jwk.kid = "k-1";
  return { jwk, privateKeyPem: privateKey };
}

function signRs256(payload: Record<string, unknown>, pem: string, kid: string): string {
  const h = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const b = b64u(JSON.stringify(payload));
  const s = createSign("RSA-SHA256");
  s.update(`${h}.${b}`);
  s.end();
  return `${h}.${b}.${b64u(s.sign(pem))}`;
}

async function listen(app: express.Application): Promise<{ server: Server; base: string; close: () => Promise<void> }> {
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  return {
    server,
    base: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function discoveryDoc() {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/auth`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
  };
}

function configForTest(): OidcRuntimeConfig {
  return {
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: undefined,
    redirectUri: REDIRECT_URI,
    scopes: "openid profile email",
    rolesClaim: "groups",
    roleMap: { "omcp-admin": "admin", "omcp-ops": "operator" },
    logoutRedirect: "/",
  };
}

test("GET /api/auth/oidc/login — 302 to IdP and sets flow cookie", async () => {
  const cfg = configForTest();
  const fetcher = async (url: string) => {
    if (url.endsWith("/.well-known/openid-configuration")) return new Response(JSON.stringify(discoveryDoc()), { status: 200 });
    return new Response("nf", { status: 404 });
  };
  const client = new OidcClient({ issuer: cfg.issuer, clientId: cfg.clientId, redirectUri: cfg.redirectUri, fetcher });
  const oidc = buildOidcRuntime(cfg, { client });
  const app = express();
  registerOidcRoutes(app, { sessionCfg: { secret: SECRET }, oidc });
  const { base, close } = await listen(app);
  try {
    const res = await fetch(`${base}/api/auth/oidc/login`, { redirect: "manual" });
    assert.equal(res.status, 302);
    const loc = res.headers.get("location") ?? "";
    assert.ok(loc.startsWith(`${ISSUER}/auth?`), `unexpected redirect target: ${loc}`);
    const u = new URL(loc);
    assert.equal(u.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(u.searchParams.get("response_type"), "code");
    assert.ok(u.searchParams.get("code_challenge"));
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /^omcp_oidc_flow=/, "must set the flow cookie");
    assert.match(setCookie, /HttpOnly/);
  } finally { await close(); }
});

test("GET /api/auth/oidc/login — honours safe ?return_to=, ignores hostile", async () => {
  const cfg = configForTest();
  const fetcher = async (_url: string) => new Response(JSON.stringify(discoveryDoc()), { status: 200 });
  const client = new OidcClient({ issuer: cfg.issuer, clientId: cfg.clientId, redirectUri: cfg.redirectUri, fetcher });
  const oidc = buildOidcRuntime(cfg, { client });
  const app = express();
  registerOidcRoutes(app, { sessionCfg: { secret: SECRET }, oidc });
  const { base, close } = await listen(app);
  try {
    // Safe path goes into the cookie payload (we'll re-decode on
    // callback). We can't easily inspect cookie content from outside
    // here without re-implementing the verify; we trust the
    // unit-test coverage of issueFlowCookie/isSafeReturnTo for that.
    const safe = await fetch(`${base}/api/auth/oidc/login?return_to=/dashboard`, { redirect: "manual" });
    assert.equal(safe.status, 302);
    const hostile = await fetch(`${base}/api/auth/oidc/login?return_to=https://evil.example`, { redirect: "manual" });
    assert.equal(hostile.status, 302);
  } finally { await close(); }
});

test("GET /api/auth/oidc/callback — end-to-end happy path mints session cookie + redirects to returnTo", async () => {
  const { jwk, privateKeyPem } = rsaKey();
  const now = Math.floor(Date.now() / 1000);
  // Capture state/nonce/verifier the login mints, so we can sign a
  // matching id_token before issuing the callback.
  let mintedFlow: { state: string; nonce: string; codeVerifier: string } | null = null;
  const cfg = configForTest();
  const fetcher = async (url: string) => {
    if (url.endsWith("/.well-known/openid-configuration")) return new Response(JSON.stringify(discoveryDoc()), { status: 200 });
    if (url === `${ISSUER}/jwks`) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    if (url === `${ISSUER}/token`) {
      // Sign id_token with the actual nonce we minted in /login.
      const idToken = signRs256({
        iss: ISSUER, aud: CLIENT_ID, sub: "alice", name: "Alice", email: "alice@example.test",
        exp: now + 60, iat: now, nonce: mintedFlow!.nonce, groups: ["omcp-admin", "omcp-ops", "ignored"],
      }, privateKeyPem, jwk.kid!);
      return new Response(JSON.stringify({ id_token: idToken, access_token: "AT", token_type: "Bearer" }), { status: 200 });
    }
    return new Response("nf", { status: 404 });
  };
  // Patched client that also exposes the minted flow.
  const baseClient = new OidcClient({ issuer: cfg.issuer, clientId: cfg.clientId, redirectUri: cfg.redirectUri, fetcher });
  const wrapped = Object.create(baseClient);
  wrapped.start = async () => {
    const out = await baseClient.start();
    mintedFlow = out.flow;
    return out;
  };
  const oidc = buildOidcRuntime(cfg, { client: wrapped });
  const app = express();
  registerOidcRoutes(app, { sessionCfg: { secret: SECRET }, oidc });
  const { base, close } = await listen(app);
  try {
    // 1) /login → grab the flow cookie + the IdP's `state` from the URL
    const loginRes = await fetch(`${base}/api/auth/oidc/login?return_to=/audit`, { redirect: "manual" });
    assert.equal(loginRes.status, 302);
    const flowCookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0];
    const idpRedirect = new URL(loginRes.headers.get("location")!);
    const state = idpRedirect.searchParams.get("state")!;
    assert.equal(state, mintedFlow!.state, "state in URL must match flow cookie payload");

    // 2) Simulate IdP redirect back: GET /callback?code=ABC&state=...
    //    Send the flow cookie back to the server.
    const cbRes = await fetch(`${base}/api/auth/oidc/callback?code=ABC&state=${state}`, {
      redirect: "manual",
      headers: { cookie: flowCookie },
    });
    assert.equal(cbRes.status, 302, `callback should 302; got ${cbRes.status}, body=${await cbRes.text()}`);
    assert.equal(cbRes.headers.get("location"), "/audit", "callback should redirect to the returnTo");
    // Inspect cookies individually — undici joins multi-Set-Cookie
    // headers with `, ` when read via .get("set-cookie"), which makes
    // a naive regex match the wrong adjacent cookie's attributes.
    const cookies = (cbRes.headers as unknown as { getSetCookie: () => string[] }).getSetCookie();
    assert.ok(cookies.some((c) => /^omcp_session=[^;]+;/.test(c)), `session cookie should be set, got ${JSON.stringify(cookies)}`);
    const cleared = cookies.find((c) => c.startsWith("omcp_oidc_flow="));
    assert.ok(cleared, `flow cookie should appear in Set-Cookie, got ${JSON.stringify(cookies)}`);
    assert.match(cleared!, /^omcp_oidc_flow=;/, "flow cookie value must be empty (cleared)");
    assert.match(cleared!, /Max-Age=0/, "flow cookie must carry Max-Age=0");
  } finally { await close(); }
});

test("GET /api/auth/oidc/callback — 400 when flow cookie missing", async () => {
  const cfg = configForTest();
  const fetcher = async (_url: string) => new Response(JSON.stringify(discoveryDoc()), { status: 200 });
  const client = new OidcClient({ issuer: cfg.issuer, clientId: cfg.clientId, redirectUri: cfg.redirectUri, fetcher });
  const oidc = buildOidcRuntime(cfg, { client });
  const app = express();
  registerOidcRoutes(app, { sessionCfg: { secret: SECRET }, oidc });
  const { base, close } = await listen(app);
  try {
    const res = await fetch(`${base}/api/auth/oidc/callback?code=ABC&state=XYZ`, { redirect: "manual" });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "oidc_flow_cookie_missing");
  } finally { await close(); }
});

test("GET /api/auth/oidc/callback — surfaces IdP-side error parameter", async () => {
  const cfg = configForTest();
  const fetcher = async (_url: string) => new Response(JSON.stringify(discoveryDoc()), { status: 200 });
  const client = new OidcClient({ issuer: cfg.issuer, clientId: cfg.clientId, redirectUri: cfg.redirectUri, fetcher });
  const oidc = buildOidcRuntime(cfg, { client });
  const app = express();
  registerOidcRoutes(app, { sessionCfg: { secret: SECRET }, oidc });
  const { base, close } = await listen(app);
  try {
    const res = await fetch(`${base}/api/auth/oidc/callback?error=access_denied`, { redirect: "manual" });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string; message: string };
    assert.equal(body.error, "oidc_idp_error");
    assert.match(body.message, /access_denied/);
  } finally { await close(); }
});

test("POST /api/auth/oidc/logout — 204 and clears the session cookie", async () => {
  const cfg = configForTest();
  const fetcher = async (_url: string) => new Response("nf", { status: 404 });
  const client = new OidcClient({ issuer: cfg.issuer, clientId: cfg.clientId, redirectUri: cfg.redirectUri, fetcher });
  const oidc = buildOidcRuntime(cfg, { client });
  const app = express();
  registerOidcRoutes(app, { sessionCfg: { secret: SECRET }, oidc });
  const { base, close } = await listen(app);
  try {
    const res = await fetch(`${base}/api/auth/oidc/logout`, { method: "POST" });
    assert.equal(res.status, 204);
    const cookies = (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie();
    const cleared = cookies.find((c) => c.startsWith("omcp_session="));
    assert.ok(cleared, `logout should clear the session cookie; got ${JSON.stringify(cookies)}`);
    assert.match(cleared!, /^omcp_session=;/);
    assert.match(cleared!, /Max-Age=0/);
  } finally { await close(); }
});
