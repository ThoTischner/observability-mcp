/**
 * Session/JWT revocation blocklist for the management plane.
 *
 * OMCP sessions are stateless signed cookies (see ./session.ts) — there is
 * no server-side session table to delete from, so a logout or a
 * compromised-credential incident can't, on its own, invalidate an
 * outstanding cookie before its `exp`. This blocklist closes that gap: a
 * small append-only JSONL file of revocations that every request consults
 * (in buildSessionAttacher) before a session payload is trusted.
 *
 * Two revocation shapes:
 *   - session: drop one specific session by its `sid`.
 *   - subject: drop every session for a `sub` issued at or before the
 *     revocation timestamp ("force re-login"). A fresh login afterwards
 *     mints a new session with a later `iat`, which is NOT caught — so
 *     subject-revoke is a logout-everywhere, not a permanent ban.
 *
 * Backend is an on-disk JSONL file (one entry per line, mode 0600). When
 * no path is configured the store is in-memory only (lost on restart);
 * set OMCP_AUTH_REVOCATION_FILE so revocations survive a restart.
 *
 * Multi-replica caveat: the file is read once at startup and the writing
 * replica updates its own in-memory index immediately, but there is no
 * live cross-replica propagation — a revocation issued on replica A is
 * not seen by replica B until B restarts. A shared-store backend (Redis,
 * mirroring the SCIM / transport stores) is the planned path to
 * fleet-wide live propagation; see docs/access-control.md.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type RevocationKind = "session" | "subject";

export interface RevocationEntry {
  kind: RevocationKind;
  /** sid for kind "session"; sub for kind "subject". */
  value: string;
  /** Revocation time, seconds since epoch. */
  revokedAt: number;
  /** Optional free-text reason (truncated by the caller). */
  reason?: string;
  /** Optional actor who issued the revocation (admin sub). */
  by?: string;
}

export interface RevocationStoreConfig {
  /** JSONL file path. Omitted → in-memory only. */
  path?: string;
  /** Clock injection for tests. Returns seconds since epoch. */
  now?: () => number;
}

/** The minimal session shape isRevoked needs to make a decision. */
export interface RevocableSession {
  sub: string;
  iat: number;
  sid?: string;
}

function defaultNow(): number {
  return Math.floor(Date.now() / 1000);
}

export class RevocationStore {
  /** Revoked individual session ids. */
  private readonly sids = new Set<string>();
  /** sub → latest subject-revocation cutoff (seconds since epoch). */
  private readonly subjectCutoffs = new Map<string, number>();
  /** Full ordered history, kept so list() can mirror the file. */
  private readonly entries: RevocationEntry[] = [];
  private readonly path?: string;
  private readonly now: () => number;
  /** Serialises appends so two concurrent revokes can't interleave a line. */
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(cfg: RevocationStoreConfig) {
    this.path = cfg.path;
    this.now = cfg.now ?? defaultNow;
  }

  /** Build a store, loading any existing on-disk blocklist. */
  static async create(cfg: RevocationStoreConfig = {}): Promise<RevocationStore> {
    const store = new RevocationStore(cfg);
    await store.load();
    return store;
  }

  /** True when this store persists to disk. */
  get persistent(): boolean {
    return !!this.path;
  }

  get filePath(): string | undefined {
    return this.path;
  }

  /** Number of revocation entries currently held. */
  get size(): number {
    return this.entries.length;
  }

  private async load(): Promise<void> {
    if (!this.path) return;
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      // ENOENT is expected on first boot — nothing to load.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // A torn / hand-edited line shouldn't take the whole store down.
        continue;
      }
      const entry = coerceEntry(parsed);
      if (entry) this.index(entry);
    }
  }

  /** Apply an entry to the in-memory indices + history (no write). */
  private index(entry: RevocationEntry): void {
    this.entries.push(entry);
    if (entry.kind === "session") {
      this.sids.add(entry.value);
    } else {
      const prev = this.subjectCutoffs.get(entry.value);
      // Keep the latest cutoff so re-revoking a subject only widens the window.
      if (prev === undefined || entry.revokedAt > prev) {
        this.subjectCutoffs.set(entry.value, entry.revokedAt);
      }
    }
  }

  private async persist(entry: RevocationEntry): Promise<void> {
    if (!this.path) return;
    const path = this.path;
    const line = JSON.stringify(entry) + "\n";
    // Chain appends; ensure the parent dir + 0600 mode on the first write.
    this.writeChain = this.writeChain.then(async () => {
      try {
        await appendFile(path, line, { mode: 0o600 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, line, { mode: 0o600 });
          return;
        }
        throw err;
      }
    });
    await this.writeChain;
  }

  /** Revoke one session by its sid. Idempotent. */
  async revokeSession(sid: string, opts: { reason?: string; by?: string } = {}): Promise<RevocationEntry> {
    const entry: RevocationEntry = {
      kind: "session",
      value: sid,
      revokedAt: this.now(),
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.by ? { by: opts.by } : {}),
    };
    this.index(entry);
    await this.persist(entry);
    return entry;
  }

  /** Revoke every session for a subject issued at or before now. */
  async revokeSubject(sub: string, opts: { reason?: string; by?: string } = {}): Promise<RevocationEntry> {
    const entry: RevocationEntry = {
      kind: "subject",
      value: sub,
      revokedAt: this.now(),
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.by ? { by: opts.by } : {}),
    };
    this.index(entry);
    await this.persist(entry);
    return entry;
  }

  /**
   * Decide whether a session is revoked. Pure + synchronous so it can run
   * on the hot path of every request without an await.
   */
  isRevoked(session: RevocableSession): boolean {
    if (session.sid && this.sids.has(session.sid)) return true;
    const cutoff = this.subjectCutoffs.get(session.sub);
    // `<=` so a session issued in the same second as the revocation is
    // also caught — the operator's intent is "kill what exists now".
    if (cutoff !== undefined && session.iat <= cutoff) return true;
    return false;
  }

  /** Snapshot of all entries, newest last (file order). */
  list(): RevocationEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }
}

/** Validate + normalise an untrusted parsed JSON line into an entry. */
function coerceEntry(v: unknown): RevocationEntry | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.kind !== "session" && o.kind !== "subject") return null;
  if (typeof o.value !== "string" || !o.value) return null;
  if (typeof o.revokedAt !== "number" || !Number.isFinite(o.revokedAt)) return null;
  const entry: RevocationEntry = { kind: o.kind, value: o.value, revokedAt: o.revokedAt };
  if (typeof o.reason === "string") entry.reason = o.reason;
  if (typeof o.by === "string") entry.by = o.by;
  return entry;
}
