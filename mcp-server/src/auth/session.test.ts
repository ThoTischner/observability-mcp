import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

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

test("issueSession mints a unique sid that round-trips through verify", () => {
  const now = 1_700_000_000;
  const a = issueSession({ sub: "alice", name: "Alice" }, { secret }, now);
  const b = issueSession({ sub: "alice", name: "Alice" }, { secret }, now);
  assert.ok(a.payload.sid, "expected a sid");
  assert.notEqual(a.payload.sid, b.payload.sid, "each session gets its own sid");

  const verified = verifySession(a.cookie, { secret }, now + 1);
  assert.ok(verified);
  assert.equal(verified.sid, a.payload.sid);
});

test("verifySession — a legacy cookie without a sid still verifies", () => {
  const now = 1_700_000_000;
  // Hand-craft a payload lacking sid (pre-Q17 shape) and sign it.
  const payload = { sub: "alice", name: "Alice", iat: now, exp: now + 3600 };
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(payloadStr).digest("base64url");
  const verified = verifySession(`${payloadStr}.${sig}`, { secret }, now + 1);
  assert.ok(verified, "legacy cookie should still verify");
  assert.equal(verified.sid, undefined);
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
