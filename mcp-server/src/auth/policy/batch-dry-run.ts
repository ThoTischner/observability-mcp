// Batch policy dry-run — Phase F16.
//
// The existing single-call dry-run probe (`GET /api/policy?roles=…
// &resource=…&action=…`) is great for "why did this one call fail"
// but doesn't scale to a security-review session reviewing a
// proposed role change. F16 adds a batch variant that evaluates
// every (subject × resource × action) combination in one pass and
// returns a matrix the UI can render as a heat-map.
//
// The handler stays out of the route file — pure compute is easier
// to unit-test and easier to reuse from a CI policy-diff job later.

import type { PolicyEngine } from "./engine.js";

export interface BatchSubject {
  /** Human-readable identifier echoed in the response (UI heat-map
   *  row label). Usually `<name>@<tenant>` or a group name. */
  key: string;
  /** Roles the subject would have at evaluation time. */
  roles: string[];
  /** Tenant the subject is acting under. Optional; defaults to the
   *  caller's session tenant at the handler level. */
  tenant?: string;
}

export interface BatchDryRunRequest {
  subjects: BatchSubject[];
  /** Resources to probe — should match VALID_RESOURCES on the
   *  active engine. Unknown resources are dropped with a note. */
  resources: string[];
  /** Actions to probe — should match VALID_ACTIONS. */
  actions: string[];
}

export interface BatchCellVerdict {
  allowed: boolean;
  reason?: string;
}

export interface BatchDryRunResult {
  /** result[subjectKey][resource][action] = { allowed, reason } */
  matrix: Record<string, Record<string, Record<string, BatchCellVerdict>>>;
  /** Anything the handler skipped: bad resource, bad action, too
   *  many cells, etc. Helps the operator fix the next batch quickly. */
  dropped: Array<{ kind: "resource" | "action" | "subject" | "cap"; value: string; reason: string }>;
  /** Summary counts to power the UI's headline stats. */
  totals: {
    cells: number;
    allow: number;
    deny: number;
  };
}

export interface BatchLimits {
  maxSubjects: number;
  maxResources: number;
  maxActions: number;
}

export const DEFAULT_BATCH_LIMITS: BatchLimits = {
  maxSubjects: 100,
  maxResources: 100,
  maxActions: 10,
};

/**
 * Run a batch dry-run against the policy engine. The engine is
 * called once per cell — for the BuiltinPolicyEngine this is pure
 * compute and cheap; for the OPA engine it's one Rego query per
 * cell. The handler caps the matrix so a careless caller can't DoS
 * an external OPA.
 */
export async function evaluateBatch(
  engine: PolicyEngine,
  req: BatchDryRunRequest,
  validResources: ReadonlySet<string>,
  validActions: ReadonlySet<string>,
  limits: BatchLimits = DEFAULT_BATCH_LIMITS,
): Promise<BatchDryRunResult> {
  const dropped: BatchDryRunResult["dropped"] = [];

  // De-duplicate inputs; preserve first-seen order.
  const seenSubjectKeys = new Set<string>();
  const subjects: BatchSubject[] = [];
  for (const s of req.subjects ?? []) {
    if (!s || typeof s.key !== "string" || !Array.isArray(s.roles)) {
      dropped.push({ kind: "subject", value: String(s?.key ?? "<malformed>"), reason: "missing key or roles[]" });
      continue;
    }
    if (seenSubjectKeys.has(s.key)) continue;
    seenSubjectKeys.add(s.key);
    subjects.push(s);
  }
  const resources = unique(req.resources ?? []).filter((r) => {
    if (!validResources.has(r)) {
      dropped.push({ kind: "resource", value: r, reason: "not in active engine's VALID_RESOURCES" });
      return false;
    }
    return true;
  });
  const actions = unique(req.actions ?? []).filter((a) => {
    if (!validActions.has(a)) {
      dropped.push({ kind: "action", value: a, reason: "not in active engine's VALID_ACTIONS" });
      return false;
    }
    return true;
  });

  // Cap enforcement — favour clear-cap-error over partial silent results.
  if (subjects.length > limits.maxSubjects) {
    dropped.push({ kind: "cap", value: `subjects=${subjects.length}`, reason: `truncated to ${limits.maxSubjects} (cap)` });
    subjects.length = limits.maxSubjects;
  }
  if (resources.length > limits.maxResources) {
    dropped.push({ kind: "cap", value: `resources=${resources.length}`, reason: `truncated to ${limits.maxResources} (cap)` });
    resources.length = limits.maxResources;
  }
  if (actions.length > limits.maxActions) {
    dropped.push({ kind: "cap", value: `actions=${actions.length}`, reason: `truncated to ${limits.maxActions} (cap)` });
    actions.length = limits.maxActions;
  }

  const matrix: BatchDryRunResult["matrix"] = {};
  let allowCount = 0;
  let denyCount = 0;
  for (const s of subjects) {
    matrix[s.key] = {};
    for (const r of resources) {
      matrix[s.key][r] = {};
      for (const a of actions) {
        const verdict = await Promise.resolve(
          engine.evaluate(
            s.roles,
            r as never,
            a as never,
            s.tenant ? { tenant: s.tenant } : undefined,
          ),
        );
        matrix[s.key][r][a] = {
          allowed: verdict.allowed,
          reason: verdict.reason,
        };
        if (verdict.allowed) allowCount += 1;
        else denyCount += 1;
      }
    }
  }

  return {
    matrix,
    dropped,
    totals: {
      cells: subjects.length * resources.length * actions.length,
      allow: allowCount,
      deny: denyCount,
    },
  };
}

function unique<T>(xs: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

/** Turn a batch result into CSV — `subject,resource,action,allowed,reason`. */
export function batchResultToCsv(result: BatchDryRunResult): string {
  const lines = ["subject,resource,action,allowed,reason"];
  for (const [subject, perResource] of Object.entries(result.matrix)) {
    for (const [resource, perAction] of Object.entries(perResource)) {
      for (const [action, verdict] of Object.entries(perAction)) {
        lines.push([
          csvEscape(subject),
          csvEscape(resource),
          csvEscape(action),
          verdict.allowed ? "allow" : "deny",
          csvEscape(verdict.reason ?? ""),
        ].join(","));
      }
    }
  }
  return lines.join("\n");
}

function csvEscape(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
