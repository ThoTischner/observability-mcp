/**
 * JWKS fetcher + cache for OIDC ID-token signature verification.
 *
 * One cache per (issuer, jwks_uri). TTL defaults to 1 hour; a cache
 * miss on an unknown `kid` triggers a single refresh in case the IdP
 * rotated the key — this is the standard "kid not found → refresh
 * once, then fail" pattern recommended by jose, openid-client etc.
 */

import type { Jwk } from "./jwt.js";
import type { Fetcher } from "./discovery.js";

export interface Jwks {
  keys: Jwk[];
}

export interface JwksClientOpts {
  fetcher?: Fetcher;
  ttlMs?: number;
  /** Cooldown between forced refresh attempts on cache miss; default 60s. */
  refreshCooldownMs?: number;
  now?: () => number;
}

interface CacheEntry {
  jwks: Jwks;
  expiresAt: number;
  lastForceRefresh: number;
}

export class JwksClient {
  private readonly fetcher: Fetcher;
  private readonly ttlMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: JwksClientOpts = {}) {
    this.fetcher = opts.fetcher ?? ((u, i) => fetch(u, i));
    this.ttlMs = opts.ttlMs ?? 3_600_000;
    this.cooldownMs = opts.refreshCooldownMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Return the JWKS for the given URI, fetching if missing or expired. */
  async get(jwksUri: string): Promise<Jwks> {
    const cached = this.cache.get(jwksUri);
    if (cached && cached.expiresAt > this.now()) return cached.jwks;
    return await this.refresh(jwksUri);
  }

  /** Look up a single key by kid. On miss, refresh once (subject to
   * the cooldown) — IdPs rotate keys without warning and the
   * discovery doc rarely changes when they do. */
  async findKey(jwksUri: string, kid: string | undefined): Promise<Jwk | undefined> {
    let jwks = await this.get(jwksUri);
    let key = pickKey(jwks, kid);
    if (key) return key;
    const cached = this.cache.get(jwksUri);
    if (cached && cached.lastForceRefresh + this.cooldownMs > this.now()) return undefined;
    jwks = await this.refresh(jwksUri, /*forced*/ true);
    key = pickKey(jwks, kid);
    return key;
  }

  invalidate(jwksUri?: string): void {
    if (jwksUri) this.cache.delete(jwksUri);
    else this.cache.clear();
  }

  private async refresh(jwksUri: string, forced = false): Promise<Jwks> {
    const res = await this.fetcher(jwksUri);
    if (!res.ok) throw new Error(`JWKS fetch failed for ${jwksUri}: HTTP ${res.status}`);
    const body = (await res.json()) as Jwks;
    if (!body || !Array.isArray(body.keys)) throw new Error(`JWKS body for ${jwksUri} is not a valid JWKS document`);
    const entry: CacheEntry = {
      jwks: body,
      expiresAt: this.now() + this.ttlMs,
      lastForceRefresh: forced ? this.now() : (this.cache.get(jwksUri)?.lastForceRefresh ?? 0),
    };
    this.cache.set(jwksUri, entry);
    return body;
  }
}

function pickKey(jwks: Jwks, kid: string | undefined): Jwk | undefined {
  if (!kid) return jwks.keys.find((k) => !!k.n || !!k.x) ?? jwks.keys[0];
  return jwks.keys.find((k) => k.kid === kid);
}
