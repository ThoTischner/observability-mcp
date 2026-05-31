import { test } from "node:test";
import assert from "node:assert/strict";

import {
  issueSession,
  verifySession,
  setCookieHeader,
  clearCookieHeader,
  readCookie,
  generateSecret,
  DEFAULT_COOKIE_NAME,
} from "./session.js";

const secret = "a".repeat(48);

test("issueSession + verifySession — round-trips identity", () => {
  const now = 1_700_000_000;
  const { cookie, payload } = issueSession(
    { sub: "alice", name: "Alice", roles: ["operator"] },
    { secret },
    now,
  );
  assert.equal(payload.sub, "alice");
  assert.equal(payload.exp, now + 12 * 60 * 60);

  const verified = verifySession(cookie, { secret }, now + 1);
  assert.ok(verified, "expected verified payload");
  assert.equal(verified.sub, "alice");
  assert.deepEqual(verified.roles, ["operator"]);
});

test("issueSession + verifySession — round-trips email when present", () => {
  const now = 1_700_000_000;
  const { cookie } = issueSession(
    { sub: "alice", name: "Alice", email: "alice@example.test", roles: ["operator"] },
    { secret },
    now,
  );
  const verified = verifySession(cookie, { secret }, now + 1);
  assert.ok(verified);
  assert.equal(verified.email, "alice@example.test");
});

test("issueSession + verifySession — omits email when caller doesn't supply one", () => {
  const now = 1_700_000_000;
  const { cookie } = issueSession({ sub: "alice", name: "Alice", roles: ["operator"] }, { secret }, now);
  const verified = verifySession(cookie, { secret }, now + 1);
  assert.ok(verified);
  assert.equal(verified.email, undefined);
});

test("verifySession — rejects an expired cookie", () => {
  const now = 1_700_000_000;
  const { cookie } = issueSession(
    { sub: "alice", name: "Alice" },
    { secret, ttlSeconds: 60 },
    now,
  );
  assert.equal(verifySession(cookie, { secret }, now + 61), null);
});

test("verifySession — rejects tampered payload", () => {
  const { cookie } = issueSession({ sub: "alice", name: "Alice" }, { secret });
  const [payload, sig] = cookie.split(".");
  const flipped = Buffer.from(payload, "base64url").toString("utf8").replace("alice", "mallory");
  const evil = Buffer.from(flipped).toString("base64url") + "." + sig;
  assert.equal(verifySession(evil, { secret }), null);
});

test("verifySession — rejects cookie signed with a different secret", () => {
  const { cookie } = issueSession({ sub: "alice", name: "Alice" }, { secret });
  assert.equal(verifySession(cookie, { secret: "b".repeat(48) }), null);
});

test("verifySession — null / empty / malformed cookies return null", () => {
  assert.equal(verifySession(null, { secret }), null);
  assert.equal(verifySession("", { secret }), null);
  assert.equal(verifySession("no-dot-anywhere", { secret }), null);
  assert.equal(verifySession(".trailing", { secret }), null);
  assert.equal(verifySession("leading.", { secret }), null);
});

test("verifySession — rejects oversized cookies before any crypto work", () => {
  const huge = "x".repeat(10_000) + "." + "y".repeat(10);
  assert.equal(verifySession(huge, { secret }), null);
});

test("verifySession — rejects short secret at verify time too (fail-closed)", () => {
  const { cookie } = issueSession({ sub: "alice", name: "Alice" }, { secret });
  assert.throws(() => verifySession(cookie, { secret: "short" }));
});

test("issueSession — rejects secrets shorter than 32 chars", () => {
  assert.throws(() => issueSession({ sub: "alice", name: "A" }, { secret: "short" }));
});

test("setCookieHeader / clearCookieHeader — render expected attributes", () => {
  const { cookie } = issueSession({ sub: "alice", name: "Alice" }, { secret });
  const setHdr = setCookieHeader(cookie, { secret });
  assert.match(setHdr, /^omcp_session=/);
  assert.match(setHdr, /HttpOnly/);
  assert.match(setHdr, /SameSite=Lax/);
  assert.match(setHdr, /Secure/);
  assert.match(setHdr, /Max-Age=43200/);

  const clearHdr = clearCookieHeader({ secret });
  assert.match(clearHdr, /^omcp_session=;/);
  assert.match(clearHdr, /Max-Age=0/);
});

test("setCookieHeader — `secure: false` omits Secure (dev / plain http)", () => {
  const { cookie } = issueSession({ sub: "alice", name: "Alice" }, { secret });
  const hdr = setCookieHeader(cookie, { secret }, { secure: false });
  assert.doesNotMatch(hdr, /Secure/);
});

test("readCookie — extracts the named cookie from a Cookie header", () => {
  assert.equal(readCookie("foo=bar; omcp_session=hello; baz=qux"), "hello");
  assert.equal(readCookie("omcp_session=hello", DEFAULT_COOKIE_NAME), "hello");
  assert.equal(readCookie(undefined), null);
  assert.equal(readCookie("missing=1"), null);
});

test("generateSecret — always returns ≥ 32 chars of url-safe entropy", () => {
  const s = generateSecret();
  assert.ok(s.length >= 32);
  assert.match(s, /^[A-Za-z0-9_-]+$/);
});
