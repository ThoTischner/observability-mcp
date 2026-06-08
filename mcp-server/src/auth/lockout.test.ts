import { test } from "node:test";
import assert from "node:assert/strict";

import { InMemorySessionStore } from "../transport/sessionStore.js";
import {
  AccountLockout,
  lockoutConfigFromEnv,
  lockoutDisabledFromEnv,
  DEFAULT_LOCKOUT_CONFIG,
} from "./lockout.js";

const cfg = { maxFailures: 3, windowSeconds: 100, baseLockSeconds: 60, maxLockSeconds: 600 };

function mk(now: { t: number }) {
  return new AccountLockout(new InMemorySessionStore(), cfg, () => now.t);
}

test("unknown account is not locked and reports full remaining attempts", async () => {
  const now = { t: 1000 };
  const lock = mk(now);
  const status = await lock.check("alice");
  assert.equal(status.locked, false);
  assert.equal(status.remainingAttempts, 3);
});

test("failures below the threshold decrement remaining attempts", async () => {
  const now = { t: 1000 };
  const lock = mk(now);
  assert.deepEqual(await lock.recordFailure("alice"), { locked: false, remainingAttempts: 2 });
  assert.deepEqual(await lock.recordFailure("alice"), { locked: false, remainingAttempts: 1 });
});

test("the Nth failure trips a lock with the base duration", async () => {
  const now = { t: 1000 };
  const lock = mk(now);
  await lock.recordFailure("alice");
  await lock.recordFailure("alice");
  const tripped = await lock.recordFailure("alice");
  assert.equal(tripped.locked, true);
  assert.equal(tripped.retryAfterSeconds, 60);

  // check() reflects the lock and counts down with the clock.
  now.t += 10;
  const status = await lock.check("alice");
  assert.equal(status.locked, true);
  assert.equal(status.retryAfterSeconds, 50);
});

test("a lapsed lock clears and lets attempts resume", async () => {
  const now = { t: 1000 };
  const lock = mk(now);
  await lock.recordFailure("alice");
  await lock.recordFailure("alice");
  await lock.recordFailure("alice"); // locked for 60s
  now.t += 61;
  const status = await lock.check("alice");
  assert.equal(status.locked, false);
});

test("progressive backoff doubles each lock, capped at maxLockSeconds", async () => {
  const now = { t: 0 };
  const lock = mk(now);
  async function tripLock(): Promise<number> {
    let last = { locked: false } as { locked: boolean; retryAfterSeconds?: number };
    for (let i = 0; i < cfg.maxFailures; i++) last = await lock.recordFailure("bob");
    return last.retryAfterSeconds!;
  }
  // Level 1 → 60, level 2 → 120, level 3 → 240, level 4 → 480, level 5 → 600 (capped).
  const durations: number[] = [];
  for (let lvl = 0; lvl < 5; lvl++) {
    const d = await tripLock();
    durations.push(d);
    now.t += d + 1; // wait out the lock before the next streak
  }
  assert.deepEqual(durations, [60, 120, 240, 480, 600]);
});

test("a blocked attempt during an active lock does not extend it", async () => {
  const now = { t: 1000 };
  const lock = mk(now);
  await lock.recordFailure("alice");
  await lock.recordFailure("alice");
  const tripped = await lock.recordFailure("alice"); // locked 60s at t=1000
  assert.equal(tripped.retryAfterSeconds, 60);

  now.t += 30;
  const blocked = await lock.recordFailure("alice"); // still locked, t=1030
  assert.equal(blocked.locked, true);
  // Deadline unchanged (1060) → 30s left, NOT re-extended to 60.
  assert.equal(blocked.retryAfterSeconds, 30);
});

test("failures outside the window reset the streak", async () => {
  const now = { t: 1000 };
  const lock = mk(now);
  await lock.recordFailure("alice"); // failures=1, firstFailureAt=1000
  await lock.recordFailure("alice"); // failures=2
  now.t += cfg.windowSeconds + 1;     // window lapsed
  const status = await lock.recordFailure("alice"); // resets to failures=1
  assert.equal(status.locked, false);
  assert.equal(status.remainingAttempts, 2);
});

test("recordSuccess clears the streak", async () => {
  const now = { t: 1000 };
  const lock = mk(now);
  await lock.recordFailure("alice");
  await lock.recordFailure("alice");
  await lock.recordSuccess("alice");
  const status = await lock.check("alice");
  assert.equal(status.locked, false);
  assert.equal(status.remainingAttempts, 3);
});

test("lockout is tracked per username — one account's lock doesn't touch another", async () => {
  const now = { t: 1000 };
  const lock = mk(now);
  await lock.recordFailure("alice");
  await lock.recordFailure("alice");
  await lock.recordFailure("alice"); // alice locked
  assert.equal((await lock.check("alice")).locked, true);
  assert.equal((await lock.check("bob")).locked, false);
  assert.equal((await lock.check("bob")).remainingAttempts, 3);
});

test("state persists with a TTL so it self-cleans", async () => {
  const store = new InMemorySessionStore();
  const now = { t: 1000 };
  const lock = new AccountLockout(store, cfg, () => now.t);
  await lock.recordFailure("alice");
  // One key written under the lockout: prefix.
  const keys = await store.keys("lockout:");
  assert.deepEqual(keys, ["lockout:alice"]);
});

test("lockoutConfigFromEnv parses overrides and falls back on bad input", () => {
  const parsed = lockoutConfigFromEnv({
    OMCP_AUTH_LOCKOUT_MAX_FAILURES: "10",
    OMCP_AUTH_LOCKOUT_WINDOW: "300",
    OMCP_AUTH_LOCKOUT_BASE: "nonsense",
    OMCP_AUTH_LOCKOUT_MAX: "-5",
  } as NodeJS.ProcessEnv);
  assert.equal(parsed.maxFailures, 10);
  assert.equal(parsed.windowSeconds, 300);
  assert.equal(parsed.baseLockSeconds, DEFAULT_LOCKOUT_CONFIG.baseLockSeconds); // bad → default
  assert.equal(parsed.maxLockSeconds, DEFAULT_LOCKOUT_CONFIG.maxLockSeconds);   // negative → default
});

test("lockoutDisabledFromEnv recognises truthy values", () => {
  assert.equal(lockoutDisabledFromEnv({ OMCP_AUTH_LOCKOUT_DISABLED: "true" } as NodeJS.ProcessEnv), true);
  assert.equal(lockoutDisabledFromEnv({ OMCP_AUTH_LOCKOUT_DISABLED: "1" } as NodeJS.ProcessEnv), true);
  assert.equal(lockoutDisabledFromEnv({ OMCP_AUTH_LOCKOUT_DISABLED: "no" } as NodeJS.ProcessEnv), false);
  assert.equal(lockoutDisabledFromEnv({} as NodeJS.ProcessEnv), false);
});
