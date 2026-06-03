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

/** Magic strings that explicitly disable the per-identity cap.
 *  Matched case-insensitively. Operators picked any of these to
 *  mean "no rate limit at all" — useful when the caps are enforced
 *  upstream (envoy / API-gateway) and OMCP shouldn't double-count. */
const UNLIMITED_TOKENS = new Set(["off", "none", "unlimited", "disabled", "false"]);

/** Resolve `OMCP_TOOL_RATE_PER_MIN` (or any equivalent caller-supplied
 * string) into the per-identity cap used by the limiter and reported
 * by `/api/info` + `/api/usage`. Single source of truth, so the three
 * call sites don't drift.
 *
 * Behaviour:
 * - unset / empty / non-numeric → DEFAULT_LIMIT_PER_MIN (60)
 * - `"0"` → DEFAULT_LIMIT_PER_MIN (limit=0 would deny every request,
 *   which is almost never what an operator setting "0" wants — they
 *   either mean "default" or "disable"; this function maps it to the
 *   default so they aren't accidentally locked out, and the explicit
 *   disable path is one of the UNLIMITED_TOKENS instead)
 * - `"off"` / `"none"` / `"unlimited"` / `"disabled"` / `"false"`
 *   (case-insensitive) → Number.POSITIVE_INFINITY, which the
 *   `count >= limit` comparison in check() always allows. JSON
 *   serialisation renders Infinity as `null`; consumers can treat
 *   a null limit as "uncapped".
 * - negative → DEFAULT_LIMIT_PER_MIN (limit=-1 with the current
 *   `count >= limit` check would also deny every request)
 * - any positive integer ≥ 1 → that value
 */
export function resolveToolRatePerMin(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT_PER_MIN;
  if (UNLIMITED_TOKENS.has(raw.trim().toLowerCase())) return Number.POSITIVE_INFINITY;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT_PER_MIN;
  return Math.floor(n);
}

export interface LimiterConfig {
  /** Default cap per identity per window. Defaults to 60. */
  limit?: number;
  /** Window length in milliseconds. Defaults to 60_000. */
  windowMs?: number;
  /** Optional per-identity override. Returns the cap for the named
   *  identity, or undefined to fall back to the default `limit`.
   *  Useful for the OMCP_KEY_RATE_PER_MIN credential-level override
   *  (`agent=600;ci=240`) — admin gives a noisy automation a higher
   *  quota without affecting every other caller. Returning Infinity
   *  disables the cap for that identity (matches the global
   *  unlimited-token contract). */
  limitFor?: (identity: string) => number | undefined;
}

/** Parse OMCP_KEY_RATE_PER_MIN — `name=count;name2=count2`. Same
 *  shape as parseKeyTenants / parseKeyProducts so operators have one
 *  syntactic model across all per-credential overrides. Unknown
 *  counts (non-numeric / ≤ 0) silently skip. Magic disable tokens
 *  (off/none/unlimited/disabled/false) map to Infinity, same as the
 *  global OMCP_TOOL_RATE_PER_MIN. */
export function parseKeyRateLimits(raw: string | undefined): Map<string, number> {
  const m = new Map<string, number>();
  if (!raw) return m;
  for (const entry of raw.split(";").map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const name = entry.slice(0, eq).trim();
    const valueRaw = entry.slice(eq + 1).trim();
    if (!name || !valueRaw) continue;
    if (UNLIMITED_TOKENS.has(valueRaw.toLowerCase())) {
      m.set(name, Number.POSITIVE_INFINITY);
      continue;
    }
    const n = Number(valueRaw);
    if (!Number.isFinite(n) || n < 1) continue;
    m.set(name, Math.floor(n));
  }
  return m;
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
  private readonly defaultLimit: number;
  private readonly windowMs: number;
  private readonly limitFor?: (identity: string) => number | undefined;
  // identity → ring of millisecond timestamps, newest at the end.
  private readonly buckets = new Map<string, number[]>();

  constructor(cfg: LimiterConfig = {}) {
    this.defaultLimit = cfg.limit ?? DEFAULT_LIMIT_PER_MIN;
    this.windowMs = cfg.windowMs ?? DEFAULT_WINDOW_MS;
    this.limitFor = cfg.limitFor;
  }

  /** Resolved cap for one identity: the per-identity override wins
   *  when defined; otherwise the process-wide default applies. */
  private resolveLimit(identity: string): number {
    if (this.limitFor) {
      const v = this.limitFor(identity);
      if (typeof v === "number" && (Number.isFinite(v) ? v >= 1 : v === Number.POSITIVE_INFINITY)) {
        return v;
      }
    }
    return this.defaultLimit;
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

    const limit = this.resolveLimit(identity);
    if (fresh.length >= limit) {
      // Compute when the oldest in-window record drops off.
      const retryAfterMs = fresh[0] + this.windowMs - now;
      // Don't store the call we just denied — that would push the
      // window forward and starve the next legitimate request.
      this.buckets.set(identity, fresh);
      return {
        allowed: false,
        count: fresh.length,
        limit,
        windowMs: this.windowMs,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    fresh.push(now);
    this.buckets.set(identity, fresh);
    return {
      allowed: true,
      count: fresh.length,
      limit,
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
    return { count, limit: this.resolveLimit(identity), windowMs: this.windowMs };
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
