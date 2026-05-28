/**
 * Per-identity sliding-window rate limiter for the MCP tool surface.
 *
 * The bearer-token credential resolved by `auth/credentials.ts`
 * (`OMCP_API_KEYS`) names every distinct caller; this limiter caps how
 * many MCP tool calls each named caller can make per minute. Anonymous
 * MCP traffic (when no `OMCP_API_KEYS` is set) bypasses the per-identity
 * cap — the existing express-rate-limit IP gate at the /mcp transport
 * still applies.
 *
 * The window is sliding: each call records its timestamp under the
 * identity's key, and `check()` first prunes entries older than the
 * configured window before counting. Memory bound is O(callers × N)
 * where N is the per-window cap — a few KB even for a busy deployment.
 *
 * Persistence is out of scope here. A future revision can plug a
 * Redis-backed store via the same interface.
 */

const DEFAULT_LIMIT_PER_MIN = 60;
const DEFAULT_WINDOW_MS = 60_000;

export interface LimiterConfig {
  /** Cap per identity per window. Defaults to 60. */
  limit?: number;
  /** Window length in milliseconds. Defaults to 60_000. */
  windowMs?: number;
}

export interface CheckResult {
  /** True when the call is allowed (and the timestamp recorded). */
  allowed: boolean;
  /** Number of calls already made in the current window (after counting this one if allowed). */
  count: number;
  /** Configured per-window cap. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
  /** Seconds until the oldest in-window record falls off and a new
   * slot opens. 0 when allowed. */
  retryAfterSeconds: number;
}

export class IdentityRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  // identity → ring of millisecond timestamps, newest at the end.
  private readonly buckets = new Map<string, number[]>();

  constructor(cfg: LimiterConfig = {}) {
    this.limit = cfg.limit ?? DEFAULT_LIMIT_PER_MIN;
    this.windowMs = cfg.windowMs ?? DEFAULT_WINDOW_MS;
  }

  /** Record-and-test a call for the given identity. Returns the
   * decision plus enough context to render a 429 with Retry-After. */
  check(identity: string, now: number = Date.now()): CheckResult {
    const cutoff = now - this.windowMs;
    const bucket = this.buckets.get(identity) ?? [];
    // Drop expired entries from the front of the bucket.
    let i = 0;
    while (i < bucket.length && bucket[i] <= cutoff) i++;
    const fresh = i === 0 ? bucket : bucket.slice(i);

    if (fresh.length >= this.limit) {
      // Compute when the oldest in-window record drops off.
      const retryAfterMs = fresh[0] + this.windowMs - now;
      // Don't store the call we just denied — that would push the
      // window forward and starve the next legitimate request.
      this.buckets.set(identity, fresh);
      return {
        allowed: false,
        count: fresh.length,
        limit: this.limit,
        windowMs: this.windowMs,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    fresh.push(now);
    this.buckets.set(identity, fresh);
    return {
      allowed: true,
      count: fresh.length,
      limit: this.limit,
      windowMs: this.windowMs,
      retryAfterSeconds: 0,
    };
  }

  /** Read-only snapshot — useful for /api/usage and tests. */
  inspect(identity: string, now: number = Date.now()): { count: number; limit: number; windowMs: number } {
    const cutoff = now - this.windowMs;
    const bucket = this.buckets.get(identity) ?? [];
    let count = 0;
    for (const t of bucket) if (t > cutoff) count++;
    return { count, limit: this.limit, windowMs: this.windowMs };
  }

  /** All identities we've ever seen — for /api/usage aggregation. */
  knownIdentities(): string[] {
    return Array.from(this.buckets.keys());
  }

  /** For testing — reset every identity's bucket. */
  reset(): void {
    this.buckets.clear();
  }
}
