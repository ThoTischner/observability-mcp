import { test } from "node:test";
import assert from "node:assert/strict";

import { IdentityRateLimiter, resolveToolRatePerMin } from "./limiter.js";

test("resolveToolRatePerMin — unset / empty / non-numeric returns default 60", () => {
  assert.equal(resolveToolRatePerMin(undefined), 60);
  assert.equal(resolveToolRatePerMin(""), 60);
  assert.equal(resolveToolRatePerMin("not-a-number"), 60);
  assert.equal(resolveToolRatePerMin("NaN"), 60);
});

test("resolveToolRatePerMin — zero / negative falls back to default (limit=0 would deny every call)", () => {
  // Footgun pin: "0" looks like "disable" but the limiter treats it as
  // "instantly over-cap". Treat as default so operators don't lock
  // themselves out by mistake.
  assert.equal(resolveToolRatePerMin("0"), 60);
  assert.equal(resolveToolRatePerMin("-1"), 60);
  assert.equal(resolveToolRatePerMin("-1000"), 60);
});

test("resolveToolRatePerMin — positive integer passes through; decimals floored", () => {
  assert.equal(resolveToolRatePerMin("1"), 1);
  assert.equal(resolveToolRatePerMin("120"), 120);
  assert.equal(resolveToolRatePerMin("240"), 240);
  assert.equal(resolveToolRatePerMin("60.7"), 60);
});

test("allows up to the configured limit, then denies", () => {
  const lim = new IdentityRateLimiter({ limit: 3, windowMs: 60_000 });
  const t = 1_700_000_000_000;
  assert.equal(lim.check("alice", t + 0).allowed, true);
  assert.equal(lim.check("alice", t + 100).allowed, true);
  assert.equal(lim.check("alice", t + 200).allowed, true);
  const denied = lim.check("alice", t + 300);
  assert.equal(denied.allowed, false);
  assert.equal(denied.count, 3);
  assert.equal(denied.limit, 3);
  assert.ok(denied.retryAfterSeconds >= 1);
});

test("sliding window: expired entries free up slots", () => {
  const lim = new IdentityRateLimiter({ limit: 2, windowMs: 10_000 });
  const t = 1_700_000_000_000;
  lim.check("alice", t + 0);
  lim.check("alice", t + 5_000);
  // At t+9s alice is still at the cap.
  assert.equal(lim.check("alice", t + 9_000).allowed, false);
  // At t+11s the first entry has aged out → one slot opens.
  const after = lim.check("alice", t + 11_000);
  assert.equal(after.allowed, true);
  assert.equal(after.count, 2);
});

test("identities are isolated from each other", () => {
  const lim = new IdentityRateLimiter({ limit: 1, windowMs: 60_000 });
  const t = 1_700_000_000_000;
  assert.equal(lim.check("alice", t).allowed, true);
  assert.equal(lim.check("alice", t).allowed, false);
  // bob has his own fresh bucket.
  assert.equal(lim.check("bob", t).allowed, true);
});

test("retryAfterSeconds points at the oldest in-window record's expiry", () => {
  const lim = new IdentityRateLimiter({ limit: 1, windowMs: 30_000 });
  const t = 1_700_000_000_000;
  lim.check("alice", t);
  const denied = lim.check("alice", t + 5_000);
  assert.equal(denied.allowed, false);
  // 30s window started at t, so expiry is t+30s → 25s from t+5s.
  assert.equal(denied.retryAfterSeconds, 25);
});

test("denied calls do NOT push the window forward", () => {
  const lim = new IdentityRateLimiter({ limit: 1, windowMs: 10_000 });
  const t = 1_700_000_000_000;
  lim.check("alice", t);
  // Multiple denies — none of them should reset the oldest-timestamp.
  for (let i = 1; i < 10; i++) lim.check("alice", t + i * 100);
  // Still expecting expiry at t+10s, not pushed forward by the denies.
  const justAfterExpiry = lim.check("alice", t + 10_001);
  assert.equal(justAfterExpiry.allowed, true);
});

test("inspect: returns counts without consuming a slot", () => {
  const lim = new IdentityRateLimiter({ limit: 5, windowMs: 60_000 });
  const t = 1_700_000_000_000;
  lim.check("alice", t);
  lim.check("alice", t);
  const ins = lim.inspect("alice", t);
  assert.equal(ins.count, 2);
  assert.equal(ins.limit, 5);
  // Subsequent check still has room for 3 more.
  assert.equal(lim.check("alice", t).allowed, true);
});

test("knownIdentities — returns every identity that has been checked", () => {
  const lim = new IdentityRateLimiter({ limit: 5, windowMs: 60_000 });
  const t = 1_700_000_000_000;
  lim.check("alice", t);
  lim.check("bob", t);
  lim.check("alice", t);
  const ids = lim.knownIdentities().sort();
  assert.deepEqual(ids, ["alice", "bob"]);
});

test("inspect on an unknown identity returns count=0", () => {
  const lim = new IdentityRateLimiter({ limit: 5, windowMs: 60_000 });
  const ins = lim.inspect("never-seen");
  assert.equal(ins.count, 0);
  assert.equal(ins.limit, 5);
});

test("reset clears all buckets", () => {
  const lim = new IdentityRateLimiter({ limit: 1, windowMs: 60_000 });
  const t = 1_700_000_000_000;
  lim.check("alice", t);
  lim.check("bob", t);
  lim.reset();
  assert.equal(lim.check("alice", t).allowed, true);
  assert.equal(lim.check("bob", t).allowed, true);
});

test("default limit applies when constructed with no args", () => {
  const lim = new IdentityRateLimiter();
  // Exhaust the default 60/min cap.
  const t = 1_700_000_000_000;
  for (let i = 0; i < 60; i++) {
    assert.equal(lim.check("alice", t + i).allowed, true);
  }
  assert.equal(lim.check("alice", t + 60).allowed, false);
});

test("resolveToolRatePerMin — explicit-disable tokens map to Infinity (any case, with whitespace)", () => {
  for (const tok of ["off", "OFF", "Off", "none", "NONE", "unlimited", "UNLIMITED", "disabled", "false", "  off  "]) {
    assert.equal(resolveToolRatePerMin(tok), Number.POSITIVE_INFINITY, `'${tok}' should disable the limiter`);
  }
});

test("IdentityRateLimiter — limit=Infinity always allows (the explicit-disable contract)", () => {
  const lim = new IdentityRateLimiter({ limit: Number.POSITIVE_INFINITY });
  const t = 1_700_000_000_000;
  // Burst far past the default cap; every call must allow.
  for (let i = 0; i < 1000; i++) {
    const r = lim.check("alice", t + i);
    assert.equal(r.allowed, true);
    assert.equal(r.retryAfterSeconds, 0);
    // Limit reflects the configured Infinity — JSON serialisation
    // would render this as null; callers can branch on Number.isFinite.
    assert.equal(r.limit, Number.POSITIVE_INFINITY);
  }
});

test("resolveToolRatePerMin — disable tokens are NOT a number trap (\"infinity\" alone is not a token)", () => {
  // We deliberately do NOT accept the literal string "infinity"
  // because Number("Infinity") === Infinity — operators expect
  // OMCP_TOOL_RATE_PER_MIN=Infinity to error out, not silently
  // mean "unlimited". The explicit tokens are off/none/unlimited/
  // disabled/false. (Number.isFinite is what the resolver checks.)
  assert.equal(resolveToolRatePerMin("Infinity"), 60, "literal 'Infinity' must NOT secretly enable unlimited mode");
});
