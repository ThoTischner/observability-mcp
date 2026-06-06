// PostmortemStore — file-backed JSONL persistence for
// generate_postmortem output.
//
// Design notes:
//   - One JSON object per line (append-only). Cheap to tail, cheap
//     to scan, surives crashes mid-write (the partial line is just
//     ignored on load).
//   - load() reads the whole file into an in-memory array (in
//     practice operators don't accumulate thousands; the tool
//     produces one report per incident).
//   - delete() rewrites the file atomically (tmp + rename). Same
//     pattern as the SCIM store from F21.
//
// The schema is intentionally narrow — we store what the tool's
// PostmortemReport already returns plus an id, ts, and createdBy.

import { readFile, writeFile, mkdir, rename, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import type { PostmortemReport } from "./synthesizer.js";

export interface StoredPostmortem {
  id: string;
  /** RFC-3339 timestamp of when the report was generated. */
  ts: string;
  /** Subject identity that called generate_postmortem. */
  createdBy: string;
  /** Tenant the report belongs to. */
  tenant: string;
  /** The shipped report shape — service + window + synopsis +
   *  markdown + sections. */
  report: PostmortemReport;
}

export class PostmortemStore {
  private readonly path: string;
  private entries: StoredPostmortem[] = [];
  private bootstrapped: Promise<void> | null = null;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<void> {
    if (this.bootstrapped) return this.bootstrapped;
    this.bootstrapped = (async () => {
      try {
        const raw = await readFile(this.path, "utf8");
        const out: StoredPostmortem[] = [];
        for (const line of raw.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          try {
            const obj = JSON.parse(t) as StoredPostmortem;
            if (obj && typeof obj.id === "string") out.push(obj);
          } catch {
            // Partial / corrupt line — skip, don't fail load. The
            // operator can purge by re-saving with delete().
          }
        }
        this.entries = out;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          this.entries = [];
          return;
        }
        console.warn(`[postmortem-store] failed to load ${this.path}: ${(err as Error).message} — starting empty`);
        this.entries = [];
      }
    })();
    return this.bootstrapped;
  }

  /** List entries, newest-first. Optionally scoped to a tenant. */
  list(tenant?: string): StoredPostmortem[] {
    const src = tenant ? this.entries.filter((e) => e.tenant === tenant) : this.entries;
    return src.slice().sort((a, b) => b.ts.localeCompare(a.ts));
  }

  get(id: string, tenant?: string): StoredPostmortem | undefined {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return undefined;
    if (tenant && e.tenant !== tenant) return undefined;
    return e;
  }

  /** Append a freshly-generated report. Returns the stored entry
   *  with its assigned id + ts. */
  async append(input: {
    report: PostmortemReport;
    createdBy: string;
    tenant: string;
  }): Promise<StoredPostmortem> {
    const entry: StoredPostmortem = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      createdBy: input.createdBy,
      tenant: input.tenant,
      report: input.report,
    };
    this.entries.push(entry);
    await mkdir(dirname(this.path), { recursive: true }).catch(() => undefined);
    // Append-only — atomic enough for a JSONL (one write = one
    // syscall; partial writes are skipped on load).
    await appendFile(this.path, JSON.stringify(entry) + "\n", { mode: 0o600 });
    return entry;
  }

  /** Delete one entry by id. Atomic rewrite. Returns whether
   *  anything was removed. */
  async delete(id: string, tenant?: string): Promise<boolean> {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => {
      if (e.id !== id) return true;
      if (tenant && e.tenant !== tenant) return true;
      return false;
    });
    if (this.entries.length === before) return false;
    await this.rewrite();
    return true;
  }

  private async rewrite(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true }).catch(() => undefined);
    const body = this.entries.map((e) => JSON.stringify(e)).join("\n") + (this.entries.length ? "\n" : "");
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
