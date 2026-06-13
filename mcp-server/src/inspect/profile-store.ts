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
  ruleId,
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
  now?: () => number;
}

export class ProfileStore {
  private rules: ProfileRule[] = [];
  private readonly file?: string;
  private readonly reader: (file: string) => string;
  private readonly writer: (file: string, data: string) => void;
  private readonly now: () => number;

  constructor(opts: ProfileStoreOptions = {}) {
    this.file = opts.file;
    this.reader = opts.reader ?? ((f) => readFileSync(f, "utf8"));
    this.writer = opts.writer ?? ((f, d) => writeFileSync(f, d));
    this.now = opts.now ?? (() => Date.now());
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

  /**
   * Absorb a single (deviating) call into the profile: widen the accepted rule
   * for (subject, tool) to include this call's resource values + arg buckets,
   * creating a tight accepted rule if none exists. Makes exactly that observed
   * shape allowed — the "add this deviation to the profile" one-click. Returns
   * the upserted rule.
   */
  absorb(call: CallSignature): ProfileRule {
    const id = ruleId(call.principal, call.tool);
    const ts = new Date(this.now()).toISOString();
    let r = this.rules.find((x) => x.id === id);
    if (!r) {
      r = { id, subject: call.principal, tool: call.tool, constraints: {}, status: "accepted", provenance: { learnedFrom: 1, firstSeen: ts, lastSeen: ts } };
      this.rules.push(r);
    } else {
      r.status = "accepted";
      r.provenance.lastSeen = ts;
    }
    const add = (arr: string[] | undefined, v: string): string[] => {
      const a = arr ?? [];
      if (!a.includes(v)) a.push(v);
      a.sort();
      return a;
    };
    for (const dim of ["source", "service", "namespace"] as const) {
      const v = call[dim];
      if (v != null) r.constraints[dim] = add(r.constraints[dim], v);
    }
    for (const [k, b] of Object.entries(call.argShape || {})) {
      r.constraints.argShape = r.constraints.argShape ?? {};
      r.constraints.argShape[k] = add(r.constraints.argShape[k], b);
    }
    this.persist();
    return r;
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
