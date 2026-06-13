// Inspect — observation store.
//
// Mirrors the audit-log storage pattern: an in-memory ring buffer (always on)
// plus an optional append-only JSONL mirror for durability. The ring is the
// query surface; the file is a write-only durable copy. Writes are best-effort
// and never throw — observation must never be able to slow down or fail a tool
// call.

import { appendFile } from "node:fs/promises";

export type Outcome = "ok" | "error";
export type Decision = "allow" | "would-block" | "blocked";

/** A single recorded tool-call observation (a signature, never raw args). */
export interface Observation {
  ts: string;
  seq: number;
  principal: string;
  auth: string;
  tenant: string;
  tool: string;
  source?: string;
  service?: string;
  namespace?: string;
  argShape: Record<string, string>;
  outcome: Outcome;
  decision: Decision;
  /** Deviation kind when the call fell outside the profile (dry-run/enforce). */
  deviation?: string;
  /** How many PII matches the redactor stripped from the args before shaping. */
  redactions: number;
}

export type ObservationInput = Omit<Observation, "ts" | "seq"> & { ts?: string };

export interface QueryOpts {
  from?: string;
  to?: string;
  principal?: string;
  tool?: string;
  outcome?: Outcome;
  decision?: Decision;
  limit?: number;
}

export interface InspectStoreOptions {
  /** JSONL mirror path. When unset, the store is memory-only. */
  file?: string;
  /** Ring-buffer capacity (default 5000). */
  cap?: number;
  /** Clock seam for tests. */
  now?: () => number;
  /** Best-effort async appender seam for tests (defaults to fs append). */
  appender?: (file: string, line: string) => Promise<void>;
}

const DEFAULT_CAP = 5000;

export class InspectStore {
  private ring: Observation[] = [];
  private readonly cap: number;
  private readonly file?: string;
  private readonly now: () => number;
  private readonly appender: (file: string, line: string) => Promise<void>;
  private seqCounter = 0;

  constructor(opts: InspectStoreOptions = {}) {
    this.cap = opts.cap && opts.cap > 0 ? opts.cap : DEFAULT_CAP;
    this.file = opts.file;
    this.now = opts.now ?? (() => Date.now());
    this.appender = opts.appender ?? ((f, line) => appendFile(f, line));
  }

  /** Record one observation. Never throws. */
  record(input: ObservationInput): Observation {
    const obs: Observation = {
      ...input,
      ts: input.ts ?? new Date(this.now()).toISOString(),
      seq: ++this.seqCounter,
    };
    this.ring.push(obs);
    if (this.ring.length > this.cap) this.ring.shift();
    if (this.file) {
      // Fire-and-forget durable mirror; a failing disk never affects the call.
      void this.appender(this.file, JSON.stringify(obs) + "\n").catch(() => {});
    }
    return obs;
  }

  /** Newest-first query with optional filters. */
  list(opts: QueryOpts = {}): Observation[] {
    const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, this.cap) : 200;
    const out: Observation[] = [];
    for (let i = this.ring.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.ring[i];
      if (opts.from && e.ts < opts.from) continue;
      if (opts.to && e.ts > opts.to) continue;
      if (opts.principal && e.principal !== opts.principal) continue;
      if (opts.tool && e.tool !== opts.tool) continue;
      if (opts.outcome && e.outcome !== opts.outcome) continue;
      if (opts.decision && e.decision !== opts.decision) continue;
      out.push(e);
    }
    return out;
  }

  /** All observations at or after `sinceMs` (epoch millis), oldest-first. */
  since(sinceMs: number): Observation[] {
    const cutoff = new Date(sinceMs).toISOString();
    return this.ring.filter((e) => e.ts >= cutoff);
  }

  /** Every observation currently retained (oldest-first). */
  all(): Observation[] {
    return [...this.ring];
  }

  get size(): number {
    return this.ring.length;
  }

  get persisted(): boolean {
    return !!this.file;
  }
}
