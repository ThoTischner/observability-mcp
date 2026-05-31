/**
 * Per-identity token-budget tracker.
 *
 * The MCP transport gets per-call sliding-window cap from
 * `IdentityRateLimiter`. Operators with paid-tier LLM agents want a
 * second axis: a daily token quota that limits the number of tokens
 * a credential can pull through the tool layer in a 24-hour rolling
 * window. This module is the data-plane half of that knob.
 *
 * Token estimation:
 *   The MCP tool response (and the agent's request args) cross the
 *   boundary as JSON text. We don't tokenize with a real tokenizer
 *   here — pulling in tiktoken / gpt-tokenizer would add a non-trivial
 *   wasm/dep that the airgapped-friendly posture wants to avoid. The
 *   estimate uses a deliberate over-approximation:
 *       tokens ≈ ceil(chars / 4) * 1.05
 *   which tends to over-count by ~5% vs. cl100k_base on prose payloads
 *   and ~15% on dense code/JSON. Under-counting is the worse error
 *   mode for budget control, so the rounding direction is intentional.
 *
 * Window:
 *   24h rolling, bucketed at 1-hour resolution to keep memory bounded.
 *   Each bucket records (hour-aligned timestamp, tokens). On every
 *   `check()` we drop buckets older than 24h and sum the rest.
 *
 * Persistence is OUT OF SCOPE for this slice (planned for E6/3). The
 * in-memory tracker is constructed fresh at boot; restart-survival
 * requires the persistence layer.
 */

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_MS = 24 * HOUR_MS;

/** Estimate tokens from a string. Intentionally over-counts. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Chars/4 is the cl100k rule-of-thumb. Multiplied by 1.05 to push
  // the estimate slightly above the real value — quota enforcement
  // wants false-positives over false-negatives.
  return Math.ceil((text.length / 4) * 1.05);
}

/** Estimate tokens for an arbitrary JSON-serialisable value. */
export function estimateTokensFor(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === "string") return estimateTokens(v);
  try { return estimateTokens(JSON.stringify(v)); } catch { return 0; }
}

export interface TokenBudgetConfig {
  /** Daily cap in tokens per identity. 0 / undefined / negative
   *  disables the cap (the limiter never denies). */
  dailyLimit?: number;
  /** Override Date.now for tests. */
  now?: () => number;
}

export interface CheckResult {
  allowed: boolean;
  /** Tokens used in the trailing 24h window AFTER this call was
   *  counted (when allowed) — or as of now (when denied). */
  used: number;
  /** Configured daily cap. 0 means uncapped. */
  limit: number;
  /** Seconds until ENOUGH buckets drop off to fit the denied request.
   *  Walks the bucket list oldest-first and stops at the first
   *  timestamp where dropping every bucket older would free
   *  >= (used + tokens - limit) tokens. Rounded up. 0 when allowed
   *  (or when uncapped). */
  retryAfterSeconds: number;
  /** How many tokens will be available again at retryAfterSeconds.
   *  Useful for HTTP 429 bodies + Retry-After hints. 0 when allowed. */
  freedAtRetry: number;
}

interface Bucket {
  /** Hour-aligned epoch ms. */
  at: number;
  tokens: number;
}

/** Per-identity 24h-rolling token budget with 1h buckets. */
export class TokenBudget {
  private readonly limit: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket[]>();

  constructor(cfg: TokenBudgetConfig = {}) {
    this.limit = cfg.dailyLimit && cfg.dailyLimit > 0 ? Math.floor(cfg.dailyLimit) : 0;
    this.now = cfg.now ?? Date.now;
  }

  /** Record-and-test: does adding `tokens` keep `identity` under the
   *  daily cap? When `allowed`, the tokens are persisted into the
   *  bucket; when denied, they are NOT recorded (so a single huge
   *  request can't push the bucket arbitrarily over the cap and
   *  starve the rest of the window). */
  check(identity: string, tokens: number, now: number = this.now()): CheckResult {
    if (this.limit <= 0) {
      // Uncapped → always allow, still track usage for /api/usage.
      this.record(identity, tokens, now);
      return { allowed: true, used: this.usedInWindow(identity, now), limit: 0, retryAfterSeconds: 0, freedAtRetry: 0 };
    }
    const safeTokens = tokens > 0 ? Math.floor(tokens) : 0;
    const existing = this.usedInWindow(identity, now);
    if (existing + safeTokens > this.limit) {
      const needed = existing + safeTokens - this.limit;
      const { waitMs, freed } = this.nextEnoughHeadroom(identity, now, needed);
      return {
        allowed: false,
        used: existing,
        limit: this.limit,
        retryAfterSeconds: waitMs > 0 ? Math.max(1, Math.ceil(waitMs / 1000)) : 1,
        freedAtRetry: freed,
      };
    }
    this.record(identity, safeTokens, now);
    return {
      allowed: true,
      used: existing + safeTokens,
      limit: this.limit,
      retryAfterSeconds: 0,
      freedAtRetry: 0,
    };
  }

  /** Read-only snapshot for /api/usage. */
  inspect(identity: string, now: number = this.now()): { used: number; limit: number; windowMs: number } {
    return { used: this.usedInWindow(identity, now), limit: this.limit, windowMs: WINDOW_MS };
  }

  /** All identities the tracker has ever seen — for /api/usage aggregation. */
  knownIdentities(): string[] {
    return Array.from(this.buckets.keys());
  }

  /** For tests — clear everything. */
  reset(): void {
    this.buckets.clear();
  }

  /** Internal: append `tokens` to the current hour's bucket for
   *  `identity`. Creates a new bucket when the hour boundary rolls. */
  private record(identity: string, tokens: number, now: number): void {
    if (tokens <= 0) return;
    const hourAt = Math.floor(now / HOUR_MS) * HOUR_MS;
    const fresh = this.pruneOld(identity, now);
    const last = fresh[fresh.length - 1];
    if (last && last.at === hourAt) {
      last.tokens += tokens;
    } else {
      fresh.push({ at: hourAt, tokens });
    }
    this.buckets.set(identity, fresh);
  }

  /** Internal: drop buckets older than 24h and return the remainder. */
  private pruneOld(identity: string, now: number): Bucket[] {
    const cutoff = now - WINDOW_MS;
    const buckets = this.buckets.get(identity) ?? [];
    let i = 0;
    while (i < buckets.length && buckets[i].at < cutoff) i++;
    if (i === 0) return buckets;
    const kept = buckets.slice(i);
    this.buckets.set(identity, kept);
    return kept;
  }

  private usedInWindow(identity: string, now: number): number {
    const fresh = this.pruneOld(identity, now);
    let total = 0;
    for (const b of fresh) total += b.tokens;
    return total;
  }

  /** Walk the bucket list oldest-first until enough tokens would have
   *  dropped off to fit a request needing `needed` extra headroom.
   *  Returns the wait in ms + the cumulative freed tokens at that
   *  point. When `needed` exceeds the entire window's content (the
   *  caller wants more than the cap), returns the time until the
   *  newest bucket drops + everything freed. */
  private nextEnoughHeadroom(identity: string, now: number, needed: number): { waitMs: number; freed: number } {
    const fresh = this.pruneOld(identity, now);
    if (fresh.length === 0) return { waitMs: 0, freed: 0 };
    let freed = 0;
    for (const b of fresh) {
      freed += b.tokens;
      if (freed >= needed) {
        const dropAt = b.at + WINDOW_MS;
        return { waitMs: Math.max(0, dropAt - now), freed };
      }
    }
    // Even dropping every bucket isn't enough — the request alone
    // exceeds the daily cap. Return the time until the newest bucket
    // drops so the caller knows the window will be empty by then; the
    // request will still get rejected on size if it exceeds limit.
    const newest = fresh[fresh.length - 1];
    return { waitMs: Math.max(0, newest.at + WINDOW_MS - now), freed };
  }
}

/** Parse OMCP_TOOL_DAILY_TOKENS into a daily limit. Mirrors the
 *  resolveToolRatePerMin pattern: unset / empty / non-numeric /
 *  zero / negative → uncapped (0). Positive integers pass through. */
export function resolveDailyTokenLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}
