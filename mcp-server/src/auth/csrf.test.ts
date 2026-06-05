import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  buildCsrfIssuer,
  buildCsrfEnforcer,
  newCsrfToken,
  csrfBypassFromEnv,
  constantTimeStringEquals,
  CSRF_COOKIE,
  CSRF_HEADER,
} from "./csrf.js";

interface MockResHeaders {
  [k: string]: string | string[];
}

class MockRes extends EventEmitter {
  status_ = 200;
  headers: MockResHeaders = {};
  body: unknown;
  status(code: number) {
    this.status_ = code;
    return this;
  }
  json(body: unknown) {
    this.body = body;
    return this;
  }
  setHeader(name: string, value: string | string[]) {
    this.headers[name] = value;
  }
  getHeader(name: string): string | string[] | undefined {
    return this.headers[name];
  }
}

function call(mw: (req: any, res: any, next: any) => void, req: any): { res: MockRes; nexted: boolean } {
  const res = new MockRes();
  let nexted = false;
  mw(req, res, () => {
    nexted = true;
  });
  return { res, nexted };
}

function defaultCfg(overrides: Partial<{ bypassBearer: boolean }> = {}) {
  return {
    bypassBearer: overrides.bypassBearer ?? true,
    secureCookie: () => false,
  };
}

test("newCsrfToken: returns base64url, 32-byte (43-44 char) string", () => {
  const t = newCsrfToken();
  assert.match(t, /^[A-Za-z0-9_-]+$/);
  assert.ok(t.length >= 42 && t.length <= 44, `unexpected length ${t.length}`);
  assert.notEqual(newCsrfToken(), newCsrfToken(), "tokens must differ");
});

test("constantTimeStringEquals: matches equal, rejects different lengths + values", () => {
  assert.equal(constantTimeStringEquals("abc", "abc"), true);
  assert.equal(constantTimeStringEquals("abc", "abd"), false);
  assert.equal(constantTimeStringEquals("abc", "abcd"), false);
  assert.equal(constantTimeStringEquals("", ""), true);
});

test("csrfBypassFromEnv: defaults true, only literal off values opt out", () => {
  assert.equal(csrfBypassFromEnv({}), true);
  assert.equal(csrfBypassFromEnv({ OMCP_CSRF_BYPASS_BEARER: "true" }), true);
  for (const v of ["0", "false", "no", "off", "FALSE", "Off"]) {
    assert.equal(csrfBypassFromEnv({ OMCP_CSRF_BYPASS_BEARER: v }), false, v);
  }
});

test("issuer: sets cookie when missing, no-op when present", () => {
  const mw = buildCsrfIssuer(defaultCfg());
  // Missing cookie -> set
  const r1 = call(mw, { headers: {} });
  assert.equal(r1.nexted, true);
  const set = r1.res.getHeader("Set-Cookie") as string;
  assert.match(set, /^omcp-csrf=[A-Za-z0-9_-]+;/);
  assert.match(set, /Path=\//);
  assert.match(set, /SameSite=Lax/);
  assert.doesNotMatch(set, /HttpOnly/);

  // Present cookie -> no Set-Cookie emitted
  const r2 = call(mw, { headers: { cookie: "omcp-csrf=abc" } });
  assert.equal(r2.nexted, true);
  assert.equal(r2.res.getHeader("Set-Cookie"), undefined);
});

test("issuer: Secure flag honors secureCookie callback", () => {
  const mw = buildCsrfIssuer({ bypassBearer: true, secureCookie: () => true });
  const r = call(mw, { headers: {} });
  assert.match(r.res.getHeader("Set-Cookie") as string, /Secure/);
});

test("enforcer: GET/HEAD/OPTIONS always pass", () => {
  const mw = buildCsrfEnforcer(defaultCfg());
  for (const m of ["GET", "HEAD", "OPTIONS"]) {
    const r = call(mw, { method: m, headers: {} });
    assert.equal(r.nexted, true, m);
  }
});

test("enforcer: bearer auth bypasses CSRF when bypassBearer=true", () => {
  const mw = buildCsrfEnforcer(defaultCfg({ bypassBearer: true }));
  const r = call(mw, {
    method: "POST",
    headers: { authorization: "Bearer abc.def.ghi" },
  });
  assert.equal(r.nexted, true);
});

test("enforcer: X-API-Key also bypasses when bypassBearer=true", () => {
  const mw = buildCsrfEnforcer(defaultCfg({ bypassBearer: true }));
  const r = call(mw, {
    method: "POST",
    headers: { "x-api-key": "abc" },
  });
  assert.equal(r.nexted, true);
});

test("enforcer: bypassBearer=false requires CSRF even for bearer clients", () => {
  const mw = buildCsrfEnforcer(defaultCfg({ bypassBearer: false }));
  const r = call(mw, {
    method: "POST",
    headers: { authorization: "Bearer abc" },
  });
  assert.equal(r.nexted, false);
  assert.equal(r.res.status_, 403);
});

test("enforcer: cookie-session POST without header is rejected with 403", () => {
  const mw = buildCsrfEnforcer(defaultCfg());
  const r = call(mw, {
    method: "POST",
    headers: { cookie: "omcp-csrf=tok123" },
  });
  assert.equal(r.nexted, false);
  assert.equal(r.res.status_, 403);
});

test("enforcer: cookie + matching header passes", () => {
  const mw = buildCsrfEnforcer(defaultCfg());
  const r = call(mw, {
    method: "POST",
    headers: { cookie: `${CSRF_COOKIE}=tok123`, [CSRF_HEADER]: "tok123" },
  });
  assert.equal(r.nexted, true);
});

test("enforcer: header != cookie is rejected (token mismatch attack)", () => {
  const mw = buildCsrfEnforcer(defaultCfg());
  const r = call(mw, {
    method: "POST",
    headers: { cookie: `${CSRF_COOKIE}=cookie-token`, [CSRF_HEADER]: "header-token" },
  });
  assert.equal(r.nexted, false);
  assert.equal(r.res.status_, 403);
});

test("enforcer: missing cookie + header is rejected (no token at all)", () => {
  const mw = buildCsrfEnforcer(defaultCfg());
  const r = call(mw, {
    method: "POST",
    headers: {},
  });
  assert.equal(r.nexted, false);
  assert.equal(r.res.status_, 403);
});
