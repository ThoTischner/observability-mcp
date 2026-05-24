/**
 * Canonical vocabulary for the connector-agnostic topology graph.
 *
 * The set is intentionally small: only values that are emitted by a shipped
 * connector OR are reserved as the agreed name for a near-term connector.
 * Adding a value is a documentation change in docs/topology-vocabulary.md
 * plus an entry in the const arrays below; never invent a value at the call
 * site without that paper trail.
 *
 * Validation is warn-only by design — a connector that emits an unknown
 * value still works, but the warning shows up in logs and unit tests so
 * vocabulary drift gets caught before it spreads.
 */

import type { Edge, Resource } from "../types.js";

export const KINDS = [
  "pod",
  "node",
  "deployment",
  "replicaset",
  "namespace",
  "service",
  "container",
  "vm",
  "host",
  "hypervisor",
  "cluster",
] as const;

export type Kind = (typeof KINDS)[number];

export const RELATIONS = [
  "RUNS_ON",
  "OWNED_BY",
  "IN_NAMESPACE",
  "CALLS",
  "CONTAINS",
  "DEPENDS_ON",
] as const;

export type Relation = (typeof RELATIONS)[number];

const KIND_SET = new Set<string>(KINDS);
const RELATION_SET = new Set<string>(RELATIONS);

export function isKnownKind(k: string): k is Kind {
  return KIND_SET.has(k);
}

export function isKnownRelation(r: string): r is Relation {
  return RELATION_SET.has(r);
}

export interface VocabularyWarning {
  kind: "unknown_resource_kind" | "unknown_relation" | "case_mismatch";
  message: string;
  value: string;
}

/**
 * Lint a single resource. Returns warnings for unknown or miscased `kind`
 * values; an empty array means the resource passes the vocabulary.
 */
export function validateResource(r: Pick<Resource, "kind">): VocabularyWarning[] {
  const out: VocabularyWarning[] = [];
  if (!isKnownKind(r.kind)) {
    const lower = r.kind.toLowerCase();
    if (isKnownKind(lower)) {
      out.push({
        kind: "case_mismatch",
        value: r.kind,
        message: `resource kind "${r.kind}" should be lowercase "${lower}" — see docs/topology-vocabulary.md`,
      });
    } else {
      out.push({
        kind: "unknown_resource_kind",
        value: r.kind,
        message: `resource kind "${r.kind}" is not in the canonical vocabulary; either rename or extend docs/topology-vocabulary.md + KINDS`,
      });
    }
  }
  return out;
}

/**
 * Lint a single edge. Returns warnings for unknown or miscased `relation`
 * values; an empty array means the edge passes the vocabulary.
 */
export function validateEdge(e: Pick<Edge, "relation">): VocabularyWarning[] {
  const out: VocabularyWarning[] = [];
  if (!isKnownRelation(e.relation)) {
    const upper = e.relation.toUpperCase();
    if (isKnownRelation(upper)) {
      out.push({
        kind: "case_mismatch",
        value: e.relation,
        message: `relation "${e.relation}" should be UPPER_SNAKE "${upper}" — see docs/topology-vocabulary.md`,
      });
    } else {
      out.push({
        kind: "unknown_relation",
        value: e.relation,
        message: `relation "${e.relation}" is not in the canonical vocabulary; either rename or extend docs/topology-vocabulary.md + RELATIONS`,
      });
    }
  }
  return out;
}

/**
 * Convenience: lint a full snapshot. Returns the de-duplicated set of
 * warnings (one per distinct value) so a noisy connector does not flood
 * the log on each tick.
 */
export function validateSnapshot(
  resources: Pick<Resource, "kind">[],
  edges: Pick<Edge, "relation">[],
): VocabularyWarning[] {
  const seen = new Set<string>();
  const out: VocabularyWarning[] = [];
  for (const r of resources) {
    for (const w of validateResource(r)) {
      const key = `r:${w.kind}:${w.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(w);
      }
    }
  }
  for (const e of edges) {
    for (const w of validateEdge(e)) {
      const key = `e:${w.kind}:${w.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(w);
      }
    }
  }
  return out;
}
