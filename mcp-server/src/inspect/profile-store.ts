// Inspect — profile persistence + CRUD.
//
// Holds the rule set, derives suggestions from observations, lets a reviewer
// accept/reject, and evaluates calls against the accepted rules. Persists to
// OMCP_INSPECT_PROFILE_FILE (JSON) when configured; in-memory otherwise.
// Reads/writes are best-effort and never throw into the call path.

import { readFileSync, writeFileSync } from "node:fs";
import type { Observation } from "./store.js";
import {
  deriveProfile,
  evaluateCall,
  type CallSignature,
  type EvalResult,
  type ProfileRule,
  type RuleStatus,
} from "./profile.js";

export interface ProfileStoreOptions {
  file?: string;
  /** Seam: initial rules (tests). */
  rules?: ProfileRule[];
  /** Seams for tests. */
  reader?: (file: string) => string;
  writer?: (file: string, data: string) => void;
}

export class ProfileStore {
  private rules: ProfileRule[] = [];
  private readonly file?: string;
  private readonly reader: (file: string) => string;
  private readonly writer: (file: string, data: string) => void;

  constructor(opts: ProfileStoreOptions = {}) {
    this.file = opts.file;
    this.reader = opts.reader ?? ((f) => readFileSync(f, "utf8"));
    this.writer = opts.writer ?? ((f, d) => writeFileSync(f, d));
    if (opts.rules) this.rules = opts.rules;
    else if (this.file) this.load();
  }

  private load(): void {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(this.reader(this.file));
      if (parsed && Array.isArray(parsed.rules)) this.rules = parsed.rules as ProfileRule[];
    } catch {
      // Missing/invalid file → start empty; never fatal.
    }
  }

  private persist(): void {
    if (!this.file) return;
    try {
      this.writer(this.file, JSON.stringify({ rules: this.rules }, null, 2));
    } catch {
      /* best-effort */
    }
  }

  list(): ProfileRule[] {
    return [...this.rules];
  }

  suggested(): ProfileRule[] {
    return this.rules.filter((r) => r.status === "suggested");
  }

  accepted(): ProfileRule[] {
    return this.rules.filter((r) => r.status === "accepted");
  }

  /** Derive suggestions from observations, merge, persist; return all rules. */
  derive(observations: Observation[]): ProfileRule[] {
    this.rules = deriveProfile(observations, this.rules);
    this.persist();
    return this.list();
  }

  /** Accept/reject/reset a rule by id. Returns the updated rule or null. */
  setStatus(id: string, status: RuleStatus): ProfileRule | null {
    const r = this.rules.find((x) => x.id === id);
    if (!r) return null;
    r.status = status;
    this.persist();
    return r;
  }

  /** Replace a rule's constraints (manual edit). Returns updated rule or null. */
  update(id: string, patch: Partial<Pick<ProfileRule, "constraints" | "subject">>): ProfileRule | null {
    const r = this.rules.find((x) => x.id === id);
    if (!r) return null;
    if (patch.constraints) r.constraints = patch.constraints;
    if (patch.subject) r.subject = patch.subject;
    this.persist();
    return r;
  }

  remove(id: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter((x) => x.id !== id);
    if (this.rules.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }

  evaluate(call: CallSignature): EvalResult {
    return evaluateCall(call, this.rules);
  }

  get size(): number {
    return this.rules.length;
  }
  get persisted(): boolean {
    return !!this.file;
  }
}
