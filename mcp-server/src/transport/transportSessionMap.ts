// Multi-replica-safe MCP transport session metadata.
//
// The actual SDK `StreamableHTTPServerTransport` object MUST live in
// the replica that originated the session — it owns the open HTTP
// response handles. What CAN be shared across replicas is the
// per-session metadata (last-active timestamp, virtual-server
// product slug, owner-replica id). This module promotes that map
// from a process-local `Map` to a small `TransportSessionMap` KV
// surface backed by either in-memory state (default) or the existing
// SessionStore Redis backend (opt-in via OMCP_REDIS_URL).
//
// Multi-replica behaviour:
//   - Replica A creates session S. Writes metadata {ownerReplica:A,
//     lastActive, product} to the shared map.
//   - Subsequent request lands on Replica B with the same S header.
//     B consults the shared map, sees ownerReplica:A, replies 410
//     so the load balancer rehashes or the client retries.
//   - This keeps the gateway functional even when sticky ingress
//     drops the affinity — the worst case is a single 410 retry,
//     not a silent NEW transport (which today races against the
//     real one).
//
// The TTL on each entry mirrors SESSION_TTL_MS so the map doesn't
// grow unbounded if a replica disappears without graceful
// shutdown — TTL-based eviction is the safety net.

import type { SessionStore } from "./sessionStore.js";

export interface TransportSessionMeta {
  /** Stable id of the replica that owns the underlying SDK
   *  Transport object. Set on creation. */
  ownerReplica: string;
  /** Optional virtual-server product slug. Undefined for the
   *  root /mcp surface. */
  product?: string;
  /** Epoch ms — bumped on every successful request. */
  lastActive: number;
}

export interface TransportSessionMap {
  /** Stable backend identifier (used in /api/info diagnostics). */
  readonly backend: string;
  /** True iff there's a metadata entry — does NOT imply a local
   *  Transport exists. */
  has(sessionId: string): Promise<boolean>;
  get(sessionId: string): Promise<TransportSessionMeta | undefined>;
  set(sessionId: string, meta: TransportSessionMeta, ttlSeconds?: number): Promise<void>;
  /** Convenience: bump lastActive while preserving the rest. */
  touch(sessionId: string, ttlSeconds?: number): Promise<void>;
  delete(sessionId: string): Promise<void>;
  /** Return every session id this map knows about. Used for the
   *  cleanup tick. Implementations MAY cap; in-memory returns the
   *  full set, Redis pages via SCAN under the prefix. */
  keys(): Promise<string[]>;
  /** Evict entries with lastActive older than `maxIdleMs`. Returns
   *  the evicted ids (caller logs / records metrics). */
  cleanup(maxIdleMs: number): Promise<string[]>;
}

// ---------------------------------------------------------------- in-memory

export class InMemoryTransportSessionMap implements TransportSessionMap {
  readonly backend = "memory";
  private readonly map = new Map<string, TransportSessionMeta>();

  async has(id: string): Promise<boolean> { return this.map.has(id); }

  async get(id: string): Promise<TransportSessionMeta | undefined> {
    return this.map.get(id);
  }

  async set(id: string, meta: TransportSessionMeta): Promise<void> {
    this.map.set(id, meta);
  }

  async touch(id: string): Promise<void> {
    const cur = this.map.get(id);
    if (!cur) return;
    cur.lastActive = Date.now();
  }

  async delete(id: string): Promise<void> { this.map.delete(id); }

  async keys(): Promise<string[]> { return [...this.map.keys()]; }

  async cleanup(maxIdleMs: number): Promise<string[]> {
    const now = Date.now();
    const evicted: string[] = [];
    for (const [id, meta] of this.map) {
      if (now - meta.lastActive > maxIdleMs) {
        this.map.delete(id);
        evicted.push(id);
      }
    }
    return evicted;
  }
}

// ---------------------------------------------------------------- SessionStore-backed

const KEY_PREFIX = "transport:";

/**
 * Wraps an existing SessionStore so the per-session metadata lives
 * wherever the SessionStore decided — InMemorySessionStore (no
 * cross-replica visibility, identical to InMemoryTransportSessionMap
 * but useful for tests / when a future backend is plugged in) or
 * RedisSessionStore (cross-replica safe).
 *
 * Each entry stored at `<KEY_PREFIX><sessionId>` as JSON.
 */
export class SessionStoreBackedTransportSessionMap implements TransportSessionMap {
  readonly backend: string;
  private readonly store: SessionStore;
  private readonly defaultTtlSeconds: number;

  constructor(store: SessionStore, defaultTtlSeconds = 30 * 60) {
    this.store = store;
    this.backend = `session-store:${store.backend}`;
    this.defaultTtlSeconds = defaultTtlSeconds;
  }

  async has(id: string): Promise<boolean> {
    return (await this.store.get<TransportSessionMeta>(KEY_PREFIX + id)) !== undefined;
  }

  async get(id: string): Promise<TransportSessionMeta | undefined> {
    return (await this.store.get<TransportSessionMeta>(KEY_PREFIX + id)) ?? undefined;
  }

  async set(id: string, meta: TransportSessionMeta, ttlSeconds?: number): Promise<void> {
    await this.store.setEx(KEY_PREFIX + id, ttlSeconds ?? this.defaultTtlSeconds, meta);
  }

  async touch(id: string, ttlSeconds?: number): Promise<void> {
    const cur = await this.get(id);
    if (!cur) return;
    cur.lastActive = Date.now();
    await this.set(id, cur, ttlSeconds);
  }

  async delete(id: string): Promise<void> {
    await this.store.del(KEY_PREFIX + id);
  }

  async keys(): Promise<string[]> {
    const raw = await this.store.keys(KEY_PREFIX);
    return raw.map((k) => k.slice(KEY_PREFIX.length));
  }

  async cleanup(maxIdleMs: number): Promise<string[]> {
    const now = Date.now();
    const ids = await this.keys();
    const evicted: string[] = [];
    for (const id of ids) {
      const meta = await this.get(id);
      if (!meta) continue;
      if (now - meta.lastActive > maxIdleMs) {
        await this.delete(id);
        evicted.push(id);
      }
    }
    return evicted;
  }
}

// ---------------------------------------------------------------- factory

/**
 * Pick the right implementation. When `sessionStore` is the
 * in-memory default, return InMemoryTransportSessionMap so we
 * avoid the (synchronous → async) layering tax. Otherwise wrap
 * the supplied store.
 */
export function createTransportSessionMap(sessionStore?: SessionStore): TransportSessionMap {
  if (!sessionStore || sessionStore.backend === "memory") {
    return new InMemoryTransportSessionMap();
  }
  return new SessionStoreBackedTransportSessionMap(sessionStore);
}
