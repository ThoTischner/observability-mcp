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
}>;

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
    this.now = () => Date.now();
  }

  /** Look up one IP via RDAP. Returns null on miss/error (never throws —
   *  a flaky RIR must not fail the batch). Cached by IP with a TTL. */
  async lookup(ip: string): Promise<IpEnrichment | null> {
    if (ipv4ToInt(ip) === null && ipv6ToBigInt(ip) === null) return null;
    const cached = this.cache.get(ip);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    let value: IpEnrichment | null = null;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        const res = await this.fetch(`${this.baseUrl}/ip/${encodeURIComponent(ip)}`, { signal: ac.signal });
        if (res.ok) value = parseRdapResponse(await res.json());
      } finally {
        clearTimeout(timer);
      }
    } catch {
      value = null; // network/timeout/parse — treat as a miss
    }

    this.put(ip, { value, expiresAt: this.now() + (value ? this.ttlMs : this.negTtlMs) });
    return value;
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
