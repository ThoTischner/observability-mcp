/**
 * Local-account lockout for the management-plane "basic" auth login.
 *
 * The per-IP rate limiter on /api/auth/login (20/min) blunts a noisy
 * brute-force, but it's keyed on the source IP — a distributed attempt, or
 * a slow drip under the IP cap, can still grind a single account's
 * password. This adds a per-username failed-login counter with progressive
 * backoff: after N failures inside a sliding window the account is
 * temporarily locked, and each subsequent lock lasts longer
 * (base · 2^(level-1), capped). A successful login clears the streak.
 *
 * State lives in the shared {@link SessionStore} so a Redis-backed
 * deployment locks consistently across replicas (and self-cleans via TTL).
 * The in-memory default keeps the single-process behaviour with no new dep.
 *
 * Lockout is tracked by the *submitted* username, whether or not it exists,
 * so it can't be used as a user-enumeration oracle and a known username
 * can't be singled out. Read-modify-write is best-effort under concurrency
 * (matching the store's eventually-consistent contract) — the worst case is
 * a couple of extra attempts slipping past the threshold, which the IP rate
 * limiter still bounds. It is never a lockout bypass for the *locked* state:
 * once `lockedUntil` is written, every replica that reads it honours it.
 */

import type { SessionStore } from "../transport/sessionStore.js";

export interface LockoutConfig {
  /** Consecutive failures within the window before a lock triggers. */
  maxFailures: number;
  /** Sliding window (seconds) over which failures accumulate. */
  windowSeconds: number;
  /** First lock duration (seconds). Doubles each subsequent lock. */
  baseLockSeconds: number;
  /** Upper bound on a single lock duration (seconds). */
  maxLockSeconds: number;
}

export const DEFAULT_LOCKOUT_CONFIG: LockoutConfig = {
  maxFailures: 5,
  windowSeconds: 15 * 60,
  baseLockSeconds: 60,
  maxLockSeconds: 60 * 60,
};

/** Persisted per-username state. */
interface LockoutState {
  /** Failure count in the current streak. */
  failures: number;
  /** Epoch seconds of the first failure in the current streak. */
  firstFailureAt: number;
  /** Epoch seconds until which the account is locked. Absent = not locked. */
  lockedUntil?: number;
  /** How many times this account has been locked — drives the backoff. */
  lockLevel: number;
}

export interface LockoutStatus {
  locked: boolean;
  /** Seconds the caller must wait, when locked. */
  retryAfterSeconds?: number;
  /** Attempts left before a lock, when not locked. */
  remainingAttempts?: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Resolve config from env, falling back to the defaults. */
export function lockoutConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LockoutConfig {
  const num = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  return {
    maxFailures: num(env.OMCP_AUTH_LOCKOUT_MAX_FAILURES, DEFAULT_LOCKOUT_CONFIG.maxFailures),
    windowSeconds: num(env.OMCP_AUTH_LOCKOUT_WINDOW, DEFAULT_LOCKOUT_CONFIG.windowSeconds),
    baseLockSeconds: num(env.OMCP_AUTH_LOCKOUT_BASE, DEFAULT_LOCKOUT_CONFIG.baseLockSeconds),
    maxLockSeconds: num(env.OMCP_AUTH_LOCKOUT_MAX, DEFAULT_LOCKOUT_CONFIG.maxLockSeconds),
  };
}

/** True when OMCP_AUTH_LOCKOUT_DISABLED is set to a truthy value. */
export function lockoutDisabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.OMCP_AUTH_LOCKOUT_DISABLED?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export class AccountLockout {
  private readonly store: SessionStore;
  private readonly cfg: LockoutConfig;
  private readonly now: () => number;
  /** TTL applied to every persisted entry so stale streaks self-clean. */
  private readonly ttlSeconds: number;

  constructor(store: SessionStore, cfg: Partial<LockoutConfig> = {}, now: () => number = nowSeconds) {
    this.store = store;
    this.cfg = { ...DEFAULT_LOCKOUT_CONFIG, ...cfg };
    this.now = now;
    // Outlast both the streak window and the longest possible lock so an
    // abandoned entry always expires, but a live lock never does early.
    this.ttlSeconds = Math.max(this.cfg.windowSeconds, this.cfg.maxLockSeconds) + 60;
  }

  private key(username: string): string {
    return `lockout:${username}`;
  }

  /** Lock duration for a given (1-based) lock level, capped. */
  private lockDuration(level: number): number {
    const exp = this.cfg.baseLockSeconds * Math.pow(2, Math.max(0, level - 1));
    return Math.min(this.cfg.maxLockSeconds, Math.floor(exp));
  }

  /**
   * Inspect lock state without mutating it. Call before verifying the
   * password — a locked account should never reach the (expensive) hash
   * comparison.
   */
  async check(username: string): Promise<LockoutStatus> {
    const state = await this.store.get<LockoutState>(this.key(username));
    const now = this.now();
    if (state?.lockedUntil && state.lockedUntil > now) {
      return { locked: true, retryAfterSeconds: state.lockedUntil - now };
    }
    const failures = this.activeFailures(state, now);
    return { locked: false, remainingAttempts: Math.max(0, this.cfg.maxFailures - failures) };
  }

  /** Failures still inside the sliding window (0 if the window lapsed). */
  private activeFailures(state: LockoutState | undefined, now: number): number {
    if (!state) return 0;
    if (now - state.firstFailureAt > this.cfg.windowSeconds) return 0;
    return state.failures;
  }

  /**
   * Record a failed login. Returns the resulting status — `locked: true`
   * when this failure tripped (or fell inside) a lock.
   */
  async recordFailure(username: string): Promise<LockoutStatus> {
    const k = this.key(username);
    const now = this.now();
    const prev = await this.store.get<LockoutState>(k);

    // If an existing lock is still active, just report it — don't extend
    // it on every blocked attempt (that would let an attacker grow the
    // legitimate user's lock unboundedly).
    if (prev?.lockedUntil && prev.lockedUntil > now) {
      return { locked: true, retryAfterSeconds: prev.lockedUntil - now };
    }

    // Continue the streak only if the window is still open; otherwise reset.
    const windowOpen = prev && now - prev.firstFailureAt <= this.cfg.windowSeconds;
    const next: LockoutState = windowOpen
      ? { ...prev!, failures: prev!.failures + 1 }
      : { failures: 1, firstFailureAt: now, lockLevel: prev?.lockLevel ?? 0 };

    if (next.failures >= this.cfg.maxFailures) {
      // Trip a lock: escalate the level, set the deadline, reset the
      // counter so the next batch of failures earns a longer lock.
      next.lockLevel += 1;
      const duration = this.lockDuration(next.lockLevel);
      next.lockedUntil = now + duration;
      next.failures = 0;
      next.firstFailureAt = now;
      await this.store.setEx(k, this.ttlSeconds, next);
      return { locked: true, retryAfterSeconds: duration };
    }

    await this.store.setEx(k, this.ttlSeconds, next);
    return { locked: false, remainingAttempts: this.cfg.maxFailures - next.failures };
  }

  /** Clear the streak on a successful login. Keeps no history. */
  async recordSuccess(username: string): Promise<void> {
    await this.store.del(this.key(username));
  }
}
