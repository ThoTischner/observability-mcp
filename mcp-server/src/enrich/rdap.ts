// Optional ONLINE IP enrichment via RDAP (RFC 9082/9083) — issue #477.
//
// OFF by default. The offline OMCP_IP_ENRICH_FILE dataset is the preferred,
// air-gapped path; RDAP is a zero-setup fallback for non-air-gapped operators
// who don't want to provision a MaxMind licence just to answer "where is this
// IP / is it a datacenter". When enabled (OMCP_IP_ENRICH_RDAP=on) the gateway
// queries the authoritative RIR over HTTPS via the rdap.org bootstrap.
//
// Privacy: RDAP queries the authoritative registry (not a third-party geo
// broker) and yields country + org/network-name only (no city, no hosting
// flag — same limits called out in #477). Results are cached with a TTL to
// respect RIR rate limits.
//
// This module makes NO network call unless an operator has opted in and the
// resolver is actually constructed (see index.ts) — the air-gapped default of
// enrich_ips is preserved.

import type { IpEnrichment } from "./ip-dataset.js";
import { ipv4ToInt, ipv6ToBigInt } from "./ip-dataset.js";

/** Minimal fetch surface so tests can inject a stub (no real network). */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  /** Optional — used to honor `Retry-After` on a throttle response. */
  headers?: { get(name: string): string | null };
}>;

/** Why a lookup failed in a way that is NOT a stable property of the address —
 *  retrying later (or in a smaller batch) may succeed. Issue #523. */
export type RdapTransientReason = "rate_limited" | "timeout" | "upstream_error" | "network_error";

/** Outcome of a single RDAP lookup. `not_found` is a genuine negative (the
 *  address is not in any registry / carries no enrichment) and is safe to
 *  cache; `transient` is an upstream failure (throttle, timeout, 5xx) that must
 *  NOT be conflated with a negative and is never cached. */
export type RdapOutcome =
  | { status: "ok"; value: IpEnrichment }
  | { status: "not_found" }
  | { status: "transient"; reason: RdapTransientReason };

export interface RdapResolverOptions {
  /** Bootstrap base; rdap.org redirects to the authoritative RIR. */
  baseUrl?: string;
  /** Cache TTL in ms (default 1h). Negative results cached for a shorter time. */
  ttlMs?: number;
  /** Per-request timeout in ms (default 4000). */
  timeoutMs?: number;
  /** Injected fetch (defaults to global fetch). */
  fetch?: FetchLike;
  /** Max cache entries (LRU-ish trim). */
  maxCache?: number;
  /** Retries on a TRANSIENT failure (throttle/timeout/5xx). Default 2. A true
   *  negative (404 / no-data) is never retried. */
  maxRetries?: number;
  /** Base backoff in ms; attempt N waits min(base * 2^N, 5000), unless the
   *  throttle response carries a usable `Retry-After`. Default 250. */
  backoffMs?: number;
  /** Injected sleep (tests pass a no-op to stay fast). Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

interface CacheEntry {
  value: IpEnrichment | null;
  expiresAt: number;
}

/** Pull a display org name out of an RDAP entity's jCard (vcardArray). */
function orgFromEntities(entities: unknown): string | undefined {
  if (!Array.isArray(entities)) return undefined;
  // Prefer registrant, then any entity with an fn.
  const ordered = [...entities].sort((a, b) => roleRank(b) - roleRank(a));
  for (const e of ordered) {
    const fn = fnFromVcard((e as { vcardArray?: unknown }).vcardArray);
    if (fn) return fn;
  }
  return undefined;
}
function roleRank(e: unknown): number {
  const roles = (e as { roles?: unknown }).roles;
  if (Array.isArray(roles) && roles.includes("registrant")) return 2;
  if (Array.isArray(roles) && roles.includes("registrar")) return 1;
  return 0;
}
function fnFromVcard(vcardArray: unknown): string | undefined {
  // jCard shape: ["vcard", [ ["version",{},"text","4.0"], ["fn",{},"text","Google LLC"], ... ]]
  if (!Array.isArray(vcardArray) || vcardArray.length < 2 || !Array.isArray(vcardArray[1])) return undefined;
  for (const prop of vcardArray[1] as unknown[]) {
    if (Array.isArray(prop) && prop[0] === "fn" && typeof prop[3] === "string" && prop[3].trim()) {
      return prop[3].trim();
    }
  }
  return undefined;
}

/** Parse an RDAP IP-network response into our enrichment shape. country +
 *  org/name only; RDAP carries no city or hosting flag. */
export function parseRdapResponse(body: unknown): IpEnrichment | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { country?: unknown; name?: unknown; entities?: unknown };
  const country = typeof b.country === "string" && b.country.trim() ? b.country.trim() : undefined;
  const org = orgFromEntities(b.entities) || (typeof b.name === "string" && b.name.trim() ? b.name.trim() : undefined);
  if (!country && !org) return null;
  const out: IpEnrichment = {};
  if (country) out.country = country;
  if (org) out.org = org;
  return out;
}

export class RdapResolver {
  private readonly baseUrl: string;
  private readonly ttlMs: number;
  private readonly negTtlMs: number;
  private readonly timeoutMs: number;
  private readonly fetch: FetchLike;
  private readonly maxCache: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private cache = new Map<string, CacheEntry>();
  /** Monotonic clock injected for tests; defaults to Date.now via a getter. */
  now: () => number;

  constructor(opts: RdapResolverOptions = {}) {
    this.baseUrl = (opts.baseUrl || "https://rdap.org").replace(/\/$/, "");
    this.ttlMs = opts.ttlMs ?? 3_600_000;
    this.negTtlMs = Math.min(this.ttlMs, 300_000);
    this.timeoutMs = opts.timeoutMs ?? 4000;
    this.fetch = opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    this.maxCache = opts.maxCache ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.backoffMs = opts.backoffMs ?? 250;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = () => Date.now();
  }

  /** Look up one IP via RDAP. Returns the enrichment on a hit, or null on a
   *  miss OR a transient failure (never throws). Back-compat shim — callers
   *  that need to tell a true negative from a throttle should use {@link resolve}. */
  async lookup(ip: string): Promise<IpEnrichment | null> {
    const o = await this.resolve(ip);
    return o.status === "ok" ? o.value : null;
  }

  /** Look up one IP via RDAP, distinguishing a genuine negative (`not_found`,
   *  cached) from a transient upstream failure (`transient`, never cached so a
   *  later retry can succeed). Bounded retry with backoff on transient. Never
   *  throws — a flaky RIR must not fail the batch (issue #523). */
  async resolve(ip: string): Promise<RdapOutcome> {
    if (ipv4ToInt(ip) === null && ipv6ToBigInt(ip) === null) return { status: "not_found" };
    const cached = this.cache.get(ip);
    if (cached && cached.expiresAt > this.now()) {
      return cached.value ? { status: "ok", value: cached.value } : { status: "not_found" };
    }

    for (let attempt = 0; ; attempt++) {
      const { outcome, retryAfterMs } = await this.attempt(ip);
      if (outcome.status === "ok") {
        this.put(ip, { value: outcome.value, expiresAt: this.now() + this.ttlMs });
        return outcome;
      }
      if (outcome.status === "not_found") {
        this.put(ip, { value: null, expiresAt: this.now() + this.negTtlMs });
        return outcome;
      }
      // transient — retry with backoff, but never cache it as a negative.
      if (attempt >= this.maxRetries) return outcome;
      const backoff = retryAfterMs ?? Math.min(this.backoffMs * 2 ** attempt, 5000);
      await this.sleep(backoff);
    }
  }

  /** One RDAP HTTP attempt mapped to an outcome (+ a Retry-After hint). */
  private async attempt(ip: string): Promise<{ outcome: RdapOutcome; retryAfterMs?: number }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(`${this.baseUrl}/ip/${encodeURIComponent(ip)}`, { signal: ac.signal });
      if (res.ok) {
        const parsed = parseRdapResponse(await res.json());
        // A 2xx with no country/org is a genuine "no enrichment for this IP".
        return { outcome: parsed ? { status: "ok", value: parsed } : { status: "not_found" } };
      }
      // 429/403 are the throttle responses RIRs use; 5xx is upstream trouble —
      // both are transient. 404 (and other malformed-query 4xx) is a genuine
      // negative for this address.
      if (res.status === 429 || res.status === 403) {
        return { outcome: { status: "transient", reason: "rate_limited" }, retryAfterMs: retryAfter(res) };
      }
      if (res.status >= 500) return { outcome: { status: "transient", reason: "upstream_error" } };
      return { outcome: { status: "not_found" } };
    } catch {
      // AbortController fired → our own timeout; otherwise a network error.
      return { outcome: { status: "transient", reason: ac.signal.aborted ? "timeout" : "network_error" } };
    } finally {
      clearTimeout(timer);
    }
  }

  private put(ip: string, entry: CacheEntry): void {
    if (this.cache.size >= this.maxCache) {
      // Drop the oldest insertion (Map preserves insertion order).
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(ip, entry);
  }
}

/** Parse a `Retry-After` header (delta-seconds form) into ms, capped at 5s so a
 *  hostile/huge value can't stall a batch. Ignores the HTTP-date form. */
function retryAfter(res: { headers?: { get(name: string): string | null } }): number | undefined {
  const raw = res.headers?.get?.("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw.trim());
  if (!Number.isFinite(secs) || secs < 0) return undefined;
  return Math.min(secs * 1000, 5000);
}
