import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAuthMiddleware, isAlwaysPublic, type AuthRuntime } from "./middleware.js";
import { issueSession, setCookieHeader, type SessionConfig } from "./session.js";

const secret = "x".repeat(48);
const sessionCfg: SessionConfig = { secret };

function mkReq(opts: { path?: string; cookieHeader?: string } = {}) {
  return {
    path: opts.path ?? "/api/sources",
    headers: { cookie: opts.cookieHeader || "" },
  } as unknown as import("express").Request;
}
function mkRes() {
  let statusCode = 0;
  let body: unknown = null;
  return {
    status(c: number) { statusCode = c; return this; },
    json(b: unknown) { body = b; return this; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  } as unknown as import("express").Response & { statusCode: number; body: unknown };
}

test("isAlwaysPublic — health probes + auth + discovery are public", () => {
  for (const p of [
    "/healthz", "/readyz", "/metrics",
    "/api/me",
    "/api/auth/login", "/api/auth/logout",
    "/api/info", "/api/openapi.json",
  ]) {
    assert.equal(isAlwaysPublic(p), true, `expected ${p} public`);
  }
});

test("isAlwaysPublic — management endpoints are not public", () => {
  for (const p of ["/api/sources", "/api/services", "/api/settings", "/api/health"]) {
    assert.equal(isAlwaysPublic(p), false, `expected ${p} not public`);
  }
});

test("anonymous mode — passes everything through unchanged", () => {
  const mw = buildAuthMiddleware({ mode: "anonymous" });
  const req = mkReq();
  const res = mkRes() as ReturnType<typeof mkRes>;
  let called = false;
  mw(req, res as unknown as import("express").Response, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.statusCode, 0);
});

test("basic mode — public path without session still flows", () => {
  const runtime: AuthRuntime = { mode: "basic", session: sessionCfg };
  const mw = buildAuthMiddleware(runtime);
  const req = mkReq({ path: "/api/me" });
  const res = mkRes() as ReturnType<typeof mkRes>;
  let called = false;
  mw(req, res as unknown as import("express").Response, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.statusCode, 0);
});

test("basic mode — protected path without session returns 401", () => {
  const runtime: AuthRuntime = { mode: "basic", session: sessionCfg };
  const mw = buildAuthMiddleware(runtime);
  const req = mkReq({ path: "/api/sources" });
  const res = mkRes() as ReturnType<typeof mkRes>;
  let called = false;
  mw(req, res as unknown as import("express").Response, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.code, "OMCP_AUTH_REQUIRED");
});

test("basic mode — protected path WITH session attaches req.session and flows", () => {
  const runtime: AuthRuntime = { mode: "basic", session: sessionCfg };
  const mw = buildAuthMiddleware(runtime);
  const { cookie } = issueSession({ sub: "alice", name: "Alice", roles: ["operator"] }, sessionCfg);
  const cookieHeader = `omcp_session=${cookie}`;
  const req = mkReq({ path: "/api/sources", cookieHeader }) as unknown as import("./middleware.js").AuthedRequest;
  const res = mkRes() as ReturnType<typeof mkRes>;
  let called = false;
  mw(req, res as unknown as import("express").Response, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.statusCode, 0);
  assert.ok(req.session, "session should be attached to request");
  assert.equal(req.session?.sub, "alice");
});

test("basic mode — tampered cookie is rejected as 401", () => {
  const runtime: AuthRuntime = { mode: "basic", session: sessionCfg };
  const mw = buildAuthMiddleware(runtime);
  const { cookie } = issueSession({ sub: "alice", name: "Alice" }, sessionCfg);
  // Flip a character in the signature portion.
  const tampered = cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  const cookieHeader = `omcp_session=${tampered}`;
  const req = mkReq({ path: "/api/sources", cookieHeader });
  const res = mkRes() as ReturnType<typeof mkRes>;
  mw(req, res as unknown as import("express").Response, () => {
    throw new Error("should not have called next");
  });
  assert.equal(res.statusCode, 401);
});

test("setCookieHeader (sanity) renders the omcp_session= cookie name", () => {
  const { cookie } = issueSession({ sub: "x", name: "x" }, sessionCfg);
  const hdr = setCookieHeader(cookie, sessionCfg);
  assert.ok(hdr.startsWith("omcp_session="));
});
