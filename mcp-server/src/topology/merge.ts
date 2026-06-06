// Topology merger — collapses Resources/Edges that come from
// multiple providers into a single deduped graph.
//
// The default unified-view is the union of every provider's
// snapshot, with no dedup. That's fine for unrelated providers
// (k8s + AWS in different accounts) but breaks down once two
// providers describe the same logical service (k8s `payment`
// Deployment + ECS `payment-service` + Tempo `trace_service`
// `payment`). Without a merger, get_blast_radius walks them as
// three independent nodes and the LLM sees ghost relationships
// instead of one real chain.
//
// Reconciliation rules, in priority order:
//   1. Explicit override via attributes.canonicalName
//   2. Match on any CANONICAL_LABEL_KEYS entry (case-insensitive)
//   3. Name + kind-compatibility table
//
// See docs/topology-vocabulary.md for the rationale.

import type { Resource, Edge, TopologySnapshot } from "../types.js";

/** Labels we treat as canonical-name carriers. First-match wins. */
export const CANONICAL_LABEL_KEYS = [
  "app.kubernetes.io/name",
  "app.kubernetes.io/instance",
  "app",
  "service",
  "service.name",
  "k8s-app",
] as const;

/** Pairs of kinds that are allowed to merge when their canonical
 *  names match. Order doesn't matter (we normalise to sorted pair). */
const MERGEABLE_KIND_PAIRS: Set<string> = new Set(
  [
    ["deployment", "cloud_service"],
    ["deployment", "trace_service"],
    ["cloud_service", "trace_service"],
    ["pod", "container"],
  ].map((p) => p.slice().sort().join("|")),
);

function kindsMergeable(a: string, b: string): boolean {
  if (a === b) return true;
  return MERGEABLE_KIND_PAIRS.has([a, b].sort().join("|"));
}

/** Lower-cased label-key lookup; first match in CANONICAL_LABEL_KEYS
 *  ordering wins so two providers with different label conventions
 *  still converge if they both ship a known label. */
export function canonicalNameFor(r: Resource): string | undefined {
  const override =
    typeof r.attributes?.canonicalName === "string"
      ? (r.attributes.canonicalName as string)
      : undefined;
  if (override) return override.toLowerCase();
  if (!r.labels) return undefined;
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(r.labels)) {
    lower.set(k.toLowerCase(), v);
  }
  for (const key of CANONICAL_LABEL_KEYS) {
    const v = lower.get(key.toLowerCase());
    if (typeof v === "string" && v.length > 0) return v.toLowerCase();
  }
  return undefined;
}

export interface MergeResult {
  resources: Resource[];
  edges: Edge[];
  /** Map from original (source-scoped) id → merged canonical id. Used
   *  to rewrite edges that referenced one of the collapsed nodes. */
  idMap: Map<string, string>;
}

/**
 * Merge a set of provider snapshots into one unified graph. The
 * input is the flat union of every provider's resources+edges; the
 * output collapses every group of nodes that share a canonical name
 * (and a compatible kind) into a single node, then rewrites the
 * edge endpoints accordingly.
 */
export function mergeTopologies(snapshots: TopologySnapshot[]): MergeResult {
  const allResources: Resource[] = [];
  const allEdges: Edge[] = [];
  for (const s of snapshots) {
    allResources.push(...s.resources);
    allEdges.push(...s.edges);
  }

  // Group by (canonical-name + kind-bucket). Resources without a
  // canonical name are passed through unchanged (one bucket each).
  const groups = new Map<string, Resource[]>();
  const passthrough: Resource[] = [];
  for (const r of allResources) {
    const canonical = canonicalNameFor(r);
    if (!canonical) {
      passthrough.push(r);
      continue;
    }
    // Bucket key tries to merge across compatible kinds: we group on
    // canonical-name alone, then verify pairwise compatibility when
    // collapsing.
    const key = canonical;
    const existing = groups.get(key);
    if (existing) existing.push(r);
    else groups.set(key, [r]);
  }

  const merged: Resource[] = [...passthrough];
  const idMap = new Map<string, string>();
  for (const bucket of groups.values()) {
    if (bucket.length === 1) {
      merged.push(bucket[0]);
      continue;
    }
    // Verify all kinds in the bucket are pairwise mergeable. If any
    // pair isn't, fall back to passing every member through
    // unchanged — better a slightly verbose graph than a wrong join.
    let allCompatible = true;
    for (let i = 0; i < bucket.length && allCompatible; i++) {
      for (let j = i + 1; j < bucket.length && allCompatible; j++) {
        if (!kindsMergeable(bucket[i].kind, bucket[j].kind)) {
          allCompatible = false;
        }
      }
    }
    if (!allCompatible) {
      merged.push(...bucket);
      continue;
    }
    const collapsed = collapseBucket(bucket);
    merged.push(collapsed);
    for (const r of bucket) {
      if (r.id !== collapsed.id) idMap.set(r.id, collapsed.id);
    }
  }

  // Rewrite edge endpoints + dedupe identical (from,to,relation)
  // tuples that arose from the collapse.
  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (const e of allEdges) {
    const from = idMap.get(e.from) ?? e.from;
    const to = idMap.get(e.to) ?? e.to;
    if (from === to) continue; // self-loop after collapse → drop
    const key = `${from}->${to}|${e.relation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ ...e, from, to });
  }

  return { resources: merged, edges, idMap };
}

function collapseBucket(bucket: Resource[]): Resource {
  // Stable choice for the canonical id: pick the first resource
  // sorted lexicographically by source then id. Source rather than
  // alphabetical so the choice doesn't flip when a label changes.
  const sorted = [...bucket].sort((a, b) => {
    const s = a.source.localeCompare(b.source);
    return s !== 0 ? s : a.id.localeCompare(b.id);
  });
  const primary = sorted[0];
  const labels: Record<string, string> = { ...primary.labels };
  const attributes: Record<string, unknown> = { ...(primary.attributes ?? {}) };
  const mergedFrom: string[] = [];
  for (const r of sorted) {
    if (r.labels) for (const [k, v] of Object.entries(r.labels)) labels[k] = v;
    if (r.attributes) for (const [k, v] of Object.entries(r.attributes)) attributes[k] = v;
    mergedFrom.push(`${r.source}:${r.id}`);
  }
  attributes.mergedFrom = mergedFrom;
  // Pick the most-specific kind for the merged node: cloud_service
  // > deployment > pod > trace_service > anything else. The merge
  // rules above already capped the bucket to compatible kinds.
  const kindPriority = ["cloud_service", "deployment", "pod", "trace_service", "container"];
  const kind =
    kindPriority.find((k) => sorted.some((r) => r.kind === k)) ?? primary.kind;
  return {
    id: primary.id,
    kind,
    name: primary.name,
    source: primary.source,
    labels,
    attributes,
  };
}
