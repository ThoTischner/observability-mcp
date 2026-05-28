import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSessionAttacher, buildRequireSession, type AuthRuntime } from "./middleware.js";
import { issueSession, type SessionConfig } from "./session.js";

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

test("session attacher — anonymous passes through unchanged, no session", () => {
  const attach = buildSessionAttacher({ mode: "anonymous" });
  const req = mkReq() as unknown as import("./middleware.js").AuthedRequest;
  let called = false;
  attach(req, mkRes() as unknown as import("express").Response, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.session, undefined);
});

test("session attacher — basic mode without cookie still flows, no session attached", () => {
  const attach = buildSessionAttacher({ mode: "basic", session: sessionCfg });
  const req = mkReq() as unknown as import("./middleware.js").AuthedRequest;
  let called = false;
  attach(req, mkRes() as unknown as import("express").Response, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.session, undefined);
});

test("session attacher — basic mode WITH valid cookie attaches session", () => {
  const { cookie } = issueSession({ sub: "alice", name: "Alice", roles: ["operator"] }, sessionCfg);
  const attach = buildSessionAttacher({ mode: "basic", session: sessionCfg });
  const req = mkReq({ cookieHeader: `omcp_session=${cookie}` }) as unknown as import("./middleware.js").AuthedRequest;
  let called = false;
  attach(req, mkRes() as unknown as import("express").Response, () => { called = true; });
  assert.equal(called, true);
  assert.ok(req.session);
  assert.equal(req.session?.sub, "alice");
});

test("session attacher — tampered cookie leaves session undefined and still flows", () => {
  const { cookie } = issueSession({ sub: "alice", name: "Alice" }, sessionCfg);
  const tampered = cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  const attach = buildSessionAttacher({ mode: "basic", session: sessionCfg });
  const req = mkReq({ cookieHeader: `omcp_session=${tampered}` }) as unknown as import("./middleware.js").AuthedRequest;
  let called = false;
  attach(req, mkRes() as unknown as import("express").Response, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.session, undefined);
});

test("require-session — anonymous always allows", () => {
  const gate = buildRequireSession({ mode: "anonymous" });
  const req = mkReq() as unknown as import("./middleware.js").AuthedRequest;
  const res = mkRes() as ReturnType<typeof mkRes>;
  let called = false;
  gate(req, res as unknown as import("express").Response, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.statusCode, 0);
});

test("require-session — basic mode without session returns 401", () => {
  const runtime: AuthRuntime = { mode: "basic", session: sessionCfg };
  const gate = buildRequireSession(runtime);
  const req = mkReq() as unknown as import("./middleware.js").AuthedRequest;
  const res = mkRes() as ReturnType<typeof mkRes>;
  let called = false;
  gate(req, res as unknown as import("express").Response, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.code, "OMCP_AUTH_REQUIRED");
});

test("require-session — basic mode WITH attached session flows through", () => {
  const runtime: AuthRuntime = { mode: "basic", session: sessionCfg };
  const gate = buildRequireSession(runtime);
  const req = mkReq() as unknown as import("./middleware.js").AuthedRequest;
  req.session = { sub: "alice", name: "Alice", iat: 0, exp: Date.now() / 1000 + 60 };
  const res = mkRes() as ReturnType<typeof mkRes>;
  let called = false;
  gate(req, res as unknown as import("express").Response, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.statusCode, 0);
});
