/**
 * Append-only audit log for the management plane.
 *
 * Distinct from the enterprise-gate audit (`enterprise/audit/`) which
 * records every gated MCP tool call. This one records every mutating
 * `/api/*` request (sources/settings/health-thresholds/connectors)
 * so an operator can answer "who changed what, when".
 *
 * On-disk format is JSONL with one entry per line. Each line includes
 * `prevHash` and `hash` (SHA-256 over the canonical JSON of the entry
 * without the hash field itself, plus the previous hash) — a
 * tamper-evident chain that `scripts/verify-audit.mjs` can walk.
 *
 * In-memory mode (no `OMCP_MGMT_AUDIT_FILE`) keeps the last
 * `inMemoryCap` entries in a ring buffer so the UI's audit tab still
 * shows something even without persistence configured. This is the
 * default in the demo / single-user case.
 */

import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";

export interface AuditEntry {
  /** RFC-3339 UTC timestamp. */
  ts: string;
  /** Monotonically-increasing per-process sequence number. */
  seq: number;
  /** Identity that triggered the change. "anonymous" when auth is off. */
  actor: { sub: string; name?: string };
  /** Logical resource + action, mirrors the RBAC vocabulary. */
  resource: string;
  action: string;
  /** Full request method + path for easy reading in the UI. */
  method: string;
  path: string;
  /** HTTP status code emitted by the gated handler. */
  status: number;
  /** Source IP, best-effort (honours X-Forwarded-For when trust-proxy is set). */
  ip?: string;
  /** Optional resource identifier extracted from the path (`:name` param). */
  target?: string;
  /** Tamper-evident chain. */
  prevHash: string;
  hash: string;
}

export interface AuditLogConfig {
  /** Absolute path to a JSONL file. When undefined, the log lives in
   * memory only. */
  file?: string;
  /** How many recent entries to keep in memory regardless of file mode. */
  inMemoryCap?: number;
}

export const DEFAULT_IN_MEMORY_CAP = 500;
const GENESIS_HASH = "0".repeat(64);

export class AuditLog {
  private readonly cap: number;
  private readonly file: string | undefined;
  private ring: AuditEntry[] = [];
  private lastHash: string = GENESIS_HASH;
  private seq = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private bootstrapped: Promise<void> | null = null;

  constructor(cfg: AuditLogConfig = {}) {
    this.cap = cfg.inMemoryCap ?? DEFAULT_IN_MEMORY_CAP;
    this.file = cfg.file;
  }

  /**
   * If a file is configured, replay it to recover seq + lastHash so a
   * server restart picks up the chain exactly where it left off.
   * Safe to call multiple times — bootstraps once and caches.
   */
  async bootstrap(): Promise<void> {
    if (!this.file) return;
    if (this.bootstrapped) return this.bootstrapped;
    this.bootstrapped = (async () => {
      let raw: string;
      try {
        raw = await readFile(this.file!, "utf8");
      } catch {
        return; // first run, fine
      }
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const entry = JSON.parse(t) as AuditEntry;
          if (typeof entry.seq === "number") this.seq = Math.max(this.seq, entry.seq);
          if (typeof entry.hash === "string") this.lastHash = entry.hash;
          if (this.ring.length === this.cap) this.ring.shift();
          this.ring.push(entry);
        } catch {
          // skip malformed line — don't fail boot on a single corrupt entry
        }
      }
    })();
    return this.bootstrapped;
  }

  /**
   * Record an event. Returns the canonical entry (with chain fields)
   * once enqueued; persistence to disk completes asynchronously.
   */
  async record(input: Omit<AuditEntry, "ts" | "seq" | "prevHash" | "hash">): Promise<AuditEntry> {
    if (this.bootstrapped) await this.bootstrapped;
    this.seq += 1;
    const ts = new Date().toISOString();
    const base = { ts, seq: this.seq, prevHash: this.lastHash, ...input };
    const hash = chainHash(base);
    const entry: AuditEntry = { ...base, hash };
    this.lastHash = hash;
    if (this.ring.length === this.cap) this.ring.shift();
    this.ring.push(entry);
    if (this.file) {
      const file = this.file;
      // Serialize disk writes so concurrent records don't interleave bytes.
      this.writeQueue = this.writeQueue.then(() =>
        appendFile(file, JSON.stringify(entry) + "\n", "utf8").catch(() => {
          // intentionally swallow — losing a single audit line is
          // strictly better than crashing the management plane.
        }),
      );
    }
    return entry;
  }

  /** Snapshot of the in-memory ring (most recent last). */
  list(opts: { from?: string; to?: string; actor?: string; action?: string; limit?: number } = {}): AuditEntry[] {
    const lim = Math.max(1, Math.min(opts.limit ?? 100, this.cap));
    const out: AuditEntry[] = [];
    for (let i = this.ring.length - 1; i >= 0 && out.length < lim; i--) {
      const e = this.ring[i];
      if (opts.from && e.ts < opts.from) continue;
      if (opts.to && e.ts > opts.to) continue;
      if (opts.actor && e.actor.sub !== opts.actor) continue;
      if (opts.action && e.action !== opts.action) continue;
      out.push(e);
    }
    return out;
  }

  /** For verification scripts. */
  get tipHash(): string { return this.lastHash; }
  get nextSeq(): number { return this.seq + 1; }
}

/** Stable hash of an entry-without-hash, against `prevHash` already present. */
export function chainHash(entryWithoutHash: Omit<AuditEntry, "hash">): string {
  // Canonical JSON: recursively sort keys so the digest is reproducible
  // independent of insertion order. Cannot use JSON.stringify's
  // string-array replacer here — that one filters at every level, which
  // would strip nested properties (e.g. actor.sub) and collapse two
  // distinct entries to the same canonical form.
  return createHash("sha256").update(canonicalJson(entryWithoutHash)).digest("hex");
}

/** Deterministic JSON for hashing — keys sorted at every depth.
 * Mirrors JSON.stringify's "drop undefined values" rule so a freshly-
 * recorded entry and a round-tripped JSON.parse() of the same entry
 * (which silently drops undefineds) hash identically. */
function canonicalJson(v: unknown): string {
  if (v === undefined) return ""; // caller must filter at the parent level
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map((x) => canonicalJson(x ?? null)).join(",") + "]";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k]))
      .join(",") +
    "}";
}

/** Walk a JSONL file end-to-end and confirm every entry's hash matches
 * the chain. Used by the offline verifier CLI. */
export function verifyChain(entries: AuditEntry[]): { ok: true } | { ok: false; brokenAt: number; reason: string } {
  let prev = GENESIS_HASH;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.prevHash !== prev) {
      return { ok: false, brokenAt: i, reason: `prevHash mismatch (expected ${prev}, got ${e.prevHash})` };
    }
    const { hash: _ignored, ...without } = e;
    const expectedHash = chainHash(without);
    if (e.hash !== expectedHash) {
      return { ok: false, brokenAt: i, reason: `hash mismatch (expected ${expectedHash}, got ${e.hash})` };
    }
    prev = e.hash;
  }
  return { ok: true };
}
