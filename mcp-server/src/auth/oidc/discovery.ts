/**
 * OIDC discovery-document fetcher with TTL cache.
 *
 * Resolves an issuer URL into the endpoint set the rest of the OIDC
 * code-flow needs. Caches per-issuer for a configurable TTL (default
 * 1 hour) — IdPs publish stable URLs but rotate them occasionally.
 *
 * `fetcher` is injectable so unit tests don't need a real network.
 */

export interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
  response_types_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
  scopes_supported?: string[];
  [k: string]: unknown;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface DiscoveryClientOpts {
  fetcher?: Fetcher;
  ttlMs?: number;
  now?: () => number;
}

interface CacheEntry {
  doc: DiscoveryDocument;
  expiresAt: number;
}

export class DiscoveryClient {
  private readonly fetcher: Fetcher;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: DiscoveryClientOpts = {}) {
    this.fetcher = opts.fetcher ?? ((u, i) => fetch(u, i));
    this.ttlMs = opts.ttlMs ?? 3_600_000;
    this.now = opts.now ?? Date.now;
  }

  /** Discover the OP metadata for the given issuer URL. */
  async discover(issuer: string): Promise<DiscoveryDocument> {
    const cached = this.cache.get(issuer);
    if (cached && cached.expiresAt > this.now()) return cached.doc;
    const url = issuer.replace(/\/$/, "") + "/.well-known/openid-configuration";
    const res = await this.fetcher(url);
    if (!res.ok) throw new Error(`OIDC discovery failed for ${issuer}: HTTP ${res.status}`);
    const doc = (await res.json()) as DiscoveryDocument;
    // Spec §4.3 — issuer in the doc MUST exactly equal the requested
    // issuer (defends against open-redirect-style metadata swaps).
    if (doc.issuer !== issuer) {
      throw new Error(`OIDC discovery issuer mismatch: requested ${issuer}, document advertised ${doc.issuer}`);
    }
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
      throw new Error(`OIDC discovery document for ${issuer} is missing required endpoints`);
    }
    this.cache.set(issuer, { doc, expiresAt: this.now() + this.ttlMs });
    return doc;
  }

  /** Drop the cache (test helper / manual rotation). */
  invalidate(issuer?: string): void {
    if (issuer) this.cache.delete(issuer);
    else this.cache.clear();
  }
}
