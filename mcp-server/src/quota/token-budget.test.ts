import { test } from "node:test";
import assert from "node:assert/strict";

import { TokenBudget, estimateTokens, estimateTokensFor, resolveDailyTokenLimit } from "./token-budget.js";

test("estimateTokens — empty/null/undefined → 0", () => {
  assert.equal(estimateTokens(""), 0);
});

test("estimateTokens — over-counts by design (~5% above chars/4)", () => {
  // 100 chars → cl100k actual is ~22-25; our estimate is ceil(100/4 * 1.05) = 27.
  // We want > chars/4 so quota enforcement errs on the strict side.
  const t = estimateTokens("x".repeat(100));
  assert.ok(t >= 26, `expected ≥26, got ${t}`);
  assert.ok(t <= 30, `expected ≤30, got ${t}`);
});

test("estimateTokensFor — handles non-string values via JSON serialisation", () => {
  assert.equal(estimateTokensFor(null), 0);
  assert.equal(estimateTokensFor(undefined), 0);
  assert.ok(estimateTokensFor({ a: 1, b: "hello" }) > 0);
  assert.ok(estimateTokensFor([1, 2, 3]) > 0);
});

test("estimateTokensFor — circular / non-serialisable returns 0 (don't crash)", () => {
  const a: Record<string, unknown> = {};
  a.self = a;
  assert.equal(estimateTokensFor(a), 0);
});

test("TokenBudget — uncapped allows everything but still tracks usage", () => {
  const t = 1_700_000_000_000;
  const b = new TokenBudget({ dailyLimit: 0, now: () => t });
  const r = b.check("alice", 999_999);
  assert.equal(r.allowed, true);
  assert.equal(r.limit, 0);
  assert.equal(b.inspect("alice").used, 999_999);
});

test("TokenBudget — allows up to the daily cap, denies the request that would exceed", () => {
  const t = 1_700_000_000_000;
  const b = new TokenBudget({ dailyLimit: 1000, now: () => t });
  assert.equal(b.check("alice", 600).allowed, true);
  assert.equal(b.check("alice", 300).allowed, true);
  // 600 + 300 = 900; +200 would push to 1100 → deny
  const denied = b.check("alice", 200);
  assert.equal(denied.allowed, false);
  assert.equal(denied.used, 900, "denied request must NOT have been recorded");
  assert.equal(denied.limit, 1000);
  assert.ok(denied.retryAfterSeconds > 0);
  // Subsequent small request within remaining headroom still works
  assert.equal(b.check("alice", 50).allowed, true);
});

test("TokenBudget — 24h rolling: buckets older than 24h drop off", () => {
  let now = 1_700_000_000_000;
  const b = new TokenBudget({ dailyLimit: 1000, now: () => now });
  b.check("alice", 800); // bucket at hour 0
  now += 23 * 60 * 60 * 1000; // +23h: still in window
  assert.equal(b.inspect("alice").used, 800);
  now += 2 * 60 * 60 * 1000; // +25h total: bucket from hour 0 drops
  assert.equal(b.inspect("alice").used, 0);
  // Full daily budget available again
  assert.equal(b.check("alice", 1000).allowed, true);
});

test("TokenBudget — denied request returns retryAfter ≈ time until enough buckets drop to fit the request", () => {
  let now = 1_700_000_000_000;
  const b = new TokenBudget({ dailyLimit: 100, now: () => now });
  b.check("alice", 100); // fully consumed at hour 0
  now += 60 * 60 * 1000; // +1h
  const denied = b.check("alice", 1);
  assert.equal(denied.allowed, false);
  // Need 1 free; oldest bucket (100 tokens) drops at hour 24 → ~23h wait.
  const expectedSeconds = 23 * 60 * 60;
  assert.ok(
    Math.abs(denied.retryAfterSeconds - expectedSeconds) < 3600,
    `expected ~${expectedSeconds}s, got ${denied.retryAfterSeconds}s`,
  );
  // freedAtRetry exposes how much will be available
  assert.equal(denied.freedAtRetry, 100);
});

test("TokenBudget — retryAfter walks enough buckets to fit a LARGER request", () => {
  let now = 1_700_000_000_000;
  const HOUR = 60 * 60 * 1000;
  const b = new TokenBudget({ dailyLimit: 1000, now: () => now });
  // Three 300-token calls spread across 3 different hours.
  b.check("alice", 300, now);              // bucket hour 0
  b.check("alice", 300, now + HOUR);       // bucket hour 1
  b.check("alice", 400, now + 2 * HOUR);   // bucket hour 2 — total 1000
  now += 3 * HOUR;
  // Now request 700 more. Need 700 free. Dropping bucket@hour0 (300)
  // only frees 300 — not enough. Dropping bucket@hour1 (300 more)
  // gets to 600 — still not enough. Dropping bucket@hour2 (400 more)
  // gets to 1000 — fits 700 with headroom.
  const denied = b.check("alice", 700);
  assert.equal(denied.allowed, false);
  // Must wait until bucket@hour1 drops (at hour 1 + 24 = hour 25),
  // we are at hour 3 → 22h wait? No — we need bucket@hour1 to drop to
  // get freed=600, still not enough. Need bucket@hour2 → drops at
  // hour 26, we're at hour 3 → 23h wait, with 1000 freed by then.
  const expectedSeconds = 23 * 60 * 60;
  assert.ok(
    Math.abs(denied.retryAfterSeconds - expectedSeconds) < 3600,
    `expected ~${expectedSeconds}s, got ${denied.retryAfterSeconds}s`,
  );
  assert.equal(denied.freedAtRetry, 1000, "all three buckets must have dropped to fit the 700 request");
});

test("TokenBudget — per-identity isolation (alice's bucket doesn't affect bob)", () => {
  const t = 1_700_000_000_000;
  const b = new TokenBudget({ dailyLimit: 1000, now: () => t });
  b.check("alice", 1000); // fully consumed
  assert.equal(b.check("alice", 1).allowed, false);
  assert.equal(b.check("bob", 500).allowed, true);
  assert.equal(b.inspect("bob").used, 500);
});

test("TokenBudget — hour bucket aggregation: 3 calls in the same hour share one bucket", () => {
  let now = 1_700_000_000_000;
  const b = new TokenBudget({ dailyLimit: 10000, now: () => now });
  b.check("alice", 100, now);
  b.check("alice", 200, now + 5_000);
  b.check("alice", 50, now + 10_000);
  assert.equal(b.inspect("alice").used, 350);
});

test("TokenBudget — knownIdentities surfaces every identity seen", () => {
  const t = 1_700_000_000_000;
  const b = new TokenBudget({ dailyLimit: 0, now: () => t });
  b.check("a", 1);
  b.check("b", 1);
  b.check("a", 1);
  assert.deepEqual(b.knownIdentities().sort(), ["a", "b"]);
});

test("TokenBudget — zero/negative tokens silently dropped", () => {
  const t = 1_700_000_000_000;
  const b = new TokenBudget({ dailyLimit: 1000, now: () => t });
  b.check("alice", 0);
  b.check("alice", -10);
  assert.equal(b.inspect("alice").used, 0);
});

test("resolveDailyTokenLimit — unset/empty/zero/negative/non-numeric → 0 (uncapped)", () => {
  assert.equal(resolveDailyTokenLimit(undefined), 0);
  assert.equal(resolveDailyTokenLimit(""), 0);
  assert.equal(resolveDailyTokenLimit("0"), 0);
  assert.equal(resolveDailyTokenLimit("-100"), 0);
  assert.equal(resolveDailyTokenLimit("not-a-number"), 0);
  assert.equal(resolveDailyTokenLimit("NaN"), 0);
});

test("resolveDailyTokenLimit — positive integers pass through; decimals floored", () => {
  assert.equal(resolveDailyTokenLimit("50000"), 50000);
  assert.equal(resolveDailyTokenLimit("1"), 1);
  assert.equal(resolveDailyTokenLimit("1234.7"), 1234);
});
