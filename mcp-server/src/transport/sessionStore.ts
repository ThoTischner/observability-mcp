// Shared session store — abstract backend for any short-lived state
// the gateway needs to keep across replicas: MCP Streamable HTTP
// session metadata, OIDC flow state (PKCE verifier, nonce, redirect
// target), DCR-registered client metadata, federation upstream
// catalogue cache.
//
// Two implementations ship in v2.0:
//
//   InMemorySessionStore — the default; preserves the pre-F8 behaviour
//     (single-replica, ephemeral on restart). No new dep, no new env.
//
//   RedisSessionStore — opt-in via OMCP_REDIS_URL. Backs all consumers
//     with a shared Redis so multi-replica deployments stop losing
//     sessions on rollouts and so federated upstreams can share a
//     cache. Driver loaded via dynamic import so the `redis` package
//     only loads when the store is configured.
//
// Consumers MUST treat returns as eventually-consistent across
// replicas: a get() right after a set() on a different replica may
// return undefined while replication catches up. Use TTLs for any
// state that must self-cleanup (the store's `setEx` honours the
// requested ttl seconds; `set` is no-expiry).

export interface SessionStore {
  /** Stable backend identifier (used in /api/info diagnostics). */
  readonly backend: string;
  /** Get a JSON-serialisable value by key. */
  get<T = unknown>(key: string): Promise<T | undefined>;
  /** Set a value with no expiry. */
  set<T = unknown>(key: string, value: T): Promise<void>;
  /** Set a value that auto-expires after `ttlSeconds`. */
  setEx<T = unknown>(key: string, ttlSeconds: number, value: T): Promise<void>;
  /** Remove a key. No-op if missing. */
  del(key: string): Promise<void>;
  /** List all keys matching a glob-style prefix (used by SCIM /
   *  DCR enumeration). Not required to be efficient; backends MAY
   *  impose a soft cap (and document it). */
  keys(prefix: string): Promise<string[]>;
  /** Best-effort shutdown — flush + disconnect any pooled clients. */
  close(): Promise<void>;
}

interface InMemoryEntry {
  value: unknown;
  expiresAt: number; // epoch ms; Infinity for no-expiry
}

/** Single-process, in-memory store. Default when OMCP_REDIS_URL is
 *  unset. Lazy expiry — entries are evicted on the next access. */
export class InMemorySessionStore implements SessionStore {
  readonly backend = "memory";
  private readonly map = new Map<string, InMemoryEntry>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    this.map.set(key, { value, expiresAt: Number.POSITIVE_INFINITY });
  }

  async setEx<T = unknown>(
    key: string,
    ttlSeconds: number,
    value: T,
  ): Promise<void> {
    this.map.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async del(key: string): Promise<void> {
    this.map.delete(key);
  }

  async keys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const now = Date.now();
    for (const [k, v] of this.map) {
      if (v.expiresAt <= now) {
        this.map.delete(k);
        continue;
      }
      if (k.startsWith(prefix)) out.push(k);
    }
    return out;
  }

  async close(): Promise<void> {
    this.map.clear();
  }

  /** Test-only: introspect size. */
  size(): number {
    return this.map.size;
  }
}

/** Redis-backed store. Constructed lazily via `connectRedisStore` so
 *  the `redis` driver only loads when actually used. */
export class RedisSessionStore implements SessionStore {
  readonly backend = "redis";
  private readonly client: RedisClientLike;
  private readonly prefix: string;

  constructor(client: RedisClientLike, prefix = "omcp:") {
    this.client = client;
    this.prefix = prefix;
  }

  private k(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const raw = await this.client.get(this.k(key));
    if (raw == null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    await this.client.set(this.k(key), JSON.stringify(value));
  }

  async setEx<T = unknown>(
    key: string,
    ttlSeconds: number,
    value: T,
  ): Promise<void> {
    await this.client.set(this.k(key), JSON.stringify(value), {
      EX: ttlSeconds,
    });
  }

  async del(key: string): Promise<void> {
    await this.client.del(this.k(key));
  }

  async keys(prefix: string): Promise<string[]> {
    const found = await this.client.keys(`${this.k(prefix)}*`);
    return found.map((k) => k.slice(this.prefix.length));
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      /* socket may already be down */
    }
  }
}

/** Minimum surface a Redis client must implement. Lets us inject a
 *  fake in tests and stays compatible across the `redis` / `ioredis`
 *  package shapes. */
export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    opts?: { EX?: number },
  ): Promise<string | null | undefined>;
  del(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  quit(): Promise<unknown>;
}

/**
 * Resolve the session store from env. Default: InMemorySessionStore.
 * When OMCP_REDIS_URL is set: load `redis` dynamically, connect, and
 * return a RedisSessionStore. On any connect failure, log + fall back
 * to InMemory (the gateway must boot even when Redis is down).
 */
export async function resolveSessionStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SessionStore> {
  const url = env.OMCP_REDIS_URL?.trim();
  if (!url) return new InMemorySessionStore();
  try {
    const { createClient } = await import("redis");
    const client = createClient({ url });
    client.on("error", (err: unknown) =>
      console.warn(
        "RedisSessionStore: client error: %s",
        err instanceof Error ? err.message : String(err),
      ),
    );
    await client.connect();
    console.log(
      "RedisSessionStore: connected (url scheme=%s, prefix=%s)",
      new URL(url).protocol.replace(/:$/, ""),
      env.OMCP_REDIS_KEY_PREFIX ?? "omcp:",
    );
    return new RedisSessionStore(
      client as unknown as RedisClientLike,
      env.OMCP_REDIS_KEY_PREFIX ?? "omcp:",
    );
  } catch (err) {
    console.warn(
      "RedisSessionStore: connect failed, falling back to in-memory store: %s",
      err instanceof Error ? err.message : String(err),
    );
    return new InMemorySessionStore();
  }
}
