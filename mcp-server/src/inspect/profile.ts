// Inspect — behavior profile (the AppArmor-style learned ruleset).
//
// A profile is a set of rules, one per (subject, tool). Each rule is *derived*
// from observed traffic (the union of resource dimensions + argument-shape
// buckets seen for that subject+tool), lands as `suggested`, and a human
// accepts / rejects it. Only `accepted` rules are consulted by evaluate() in
// dry-run / enforce — `suggested` rules never block anything.
//
// derive() is idempotent: re-running refreshes `suggested` rules from fresh
// traffic but never mutates a human's accepted/rejected decision, and never
// resurrects a rejected rule.

import type { Observation } from "./store.js";

export type RuleStatus = "suggested" | "accepted" | "rejected";
export type DeviationKind = "new-principal" | "new-tool" | "new-resource" | "arg-out-of-range";

export interface RuleConstraints {
  source?: string[];
  service?: string[];
  namespace?: string[];
  /** Per arg key → the set of buckets seen during learning. */
  argShape?: Record<string, string[]>;
}

export interface ProfileRule {
  id: string;
  subject: string;
  tool: string;
  constraints: RuleConstraints;
  status: RuleStatus;
  provenance: { learnedFrom: number; firstSeen: string; lastSeen: string };
}

export interface EvalResult {
  verdict: "allow" | "deviation";
  kind?: DeviationKind;
  ruleId?: string;
  detail?: string;
}

/** Stable per (subject, tool) id so derive() is idempotent. */
export function ruleId(subject: string, tool: string): string {
  return subject + "::" + tool;
}

const RES_DIMS = ["source", "service", "namespace"] as const;
type ResDim = (typeof RES_DIMS)[number];

function uniqSorted(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

/** Build a constraint set from a group of observations. */
function constraintsFrom(group: Observation[]): RuleConstraints {
  const c: RuleConstraints = {};
  for (const dim of RES_DIMS) {
    const vals = group.map((o) => o[dim]).filter((v): v is string => typeof v === "string" && v.length > 0);
    if (vals.length) c[dim] = uniqSorted(vals);
  }
  const argKeys = new Set<string>();
  group.forEach((o) => Object.keys(o.argShape || {}).forEach((k) => argKeys.add(k)));
  if (argKeys.size) {
    c.argShape = {};
    for (const k of argKeys) {
      const buckets = group.map((o) => o.argShape?.[k]).filter((v): v is string => typeof v === "string");
      c.argShape[k] = uniqSorted(buckets);
    }
  }
  return c;
}

/**
 * Derive suggested rules from observations, merged onto an existing rule set.
 * Returns the FULL updated rule list. Accepted/rejected rules are preserved;
 * suggested rules are refreshed from the latest traffic.
 */
export function deriveProfile(observations: Observation[], existing: ProfileRule[] = []): ProfileRule[] {
  const byId = new Map<string, ProfileRule>();
  for (const r of existing) byId.set(r.id, r);

  // Group observations by (subject, tool).
  const groups = new Map<string, Observation[]>();
  for (const o of observations) {
    const id = ruleId(o.principal, o.tool);
    const g = groups.get(id);
    if (g) g.push(o);
    else groups.set(id, [o]);
  }

  for (const [id, group] of groups) {
    const existingRule = byId.get(id);
    if (existingRule && existingRule.status !== "suggested") continue; // never touch a human decision
    const sorted = [...group].sort((a, b) => a.ts.localeCompare(b.ts));
    byId.set(id, {
      id,
      subject: group[0].principal,
      tool: group[0].tool,
      constraints: constraintsFrom(group),
      status: "suggested",
      provenance: {
        learnedFrom: group.length,
        firstSeen: sorted[0].ts,
        lastSeen: sorted[sorted.length - 1].ts,
      },
    });
  }
  return [...byId.values()];
}

/** A minimal call shape evaluate() needs (a subset of an Observation). */
export interface CallSignature {
  principal: string;
  tool: string;
  source?: string;
  service?: string;
  namespace?: string;
  argShape: Record<string, string>;
}

/**
 * Evaluate a call against the ACCEPTED rules of a profile. Returns allow when
 * an accepted rule covers it, else a deviation classified by kind. Suggested /
 * rejected rules are ignored.
 */
export function evaluateCall(call: CallSignature, rules: ProfileRule[]): EvalResult {
  const accepted = rules.filter((r) => r.status === "accepted");
  const subjectRules = accepted.filter((r) => r.subject === call.principal || r.subject === "*");
  if (subjectRules.length === 0) {
    // Has the subject any accepted rule at all? (Distinguishes a wholly-new
    // principal from a known principal reaching for a new tool.)
    const known = accepted.some((r) => r.subject === call.principal);
    return { verdict: "deviation", kind: known ? "new-tool" : "new-principal" };
  }
  const rule = subjectRules.find((r) => r.tool === call.tool);
  if (!rule) return { verdict: "deviation", kind: "new-tool" };

  for (const dim of RES_DIMS) {
    const v = call[dim];
    if (v == null) continue;
    const allowed = rule.constraints[dim];
    if (!allowed || !allowed.includes(v)) {
      return { verdict: "deviation", kind: "new-resource", ruleId: rule.id, detail: `${dim}=${v}` };
    }
  }
  for (const [k, bucket] of Object.entries(call.argShape || {})) {
    const allowed = rule.constraints.argShape?.[k];
    if (!allowed || !allowed.includes(bucket)) {
      return { verdict: "deviation", kind: "arg-out-of-range", ruleId: rule.id, detail: `${k}=${bucket}` };
    }
  }
  return { verdict: "allow", ruleId: rule.id };
}
