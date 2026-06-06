import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeTopologies, canonicalNameFor } from "./merge.js";
import type { Resource, Edge, TopologySnapshot } from "../types.js";

function r(id: string, kind: string, opts: { source?: string; labels?: Record<string, string>; canonical?: string; name?: string } = {}): Resource {
  return {
    id,
    kind,
    name: opts.name ?? id,
    source: opts.source ?? "test",
    labels: opts.labels ?? {},
    attributes: opts.canonical ? { canonicalName: opts.canonical } : undefined,
  };
}

function e(from: string, to: string, relation = "RUNS_ON", source = "test"): Edge {
  return { from, to, relation, source, confidence: 1.0 };
}

function snap(resources: Resource[], edges: Edge[] = []): TopologySnapshot {
  return { source: "test", resources, edges, revision: 1 };
}

test("canonicalNameFor: attributes.canonicalName wins, lowercased", () => {
  const got = canonicalNameFor(r("x", "deployment", { canonical: "Payment-Service" }));
  assert.equal(got, "payment-service");
});

test("canonicalNameFor: first matching CANONICAL_LABEL_KEYS entry wins", () => {
  // app.kubernetes.io/name beats app
  assert.equal(
    canonicalNameFor(r("x", "deployment", { labels: { "app.kubernetes.io/name": "wins", app: "loses" } })),
    "wins",
  );
  // app beats service when app.kubernetes.io/name absent
  assert.equal(
    canonicalNameFor(r("x", "deployment", { labels: { app: "wins", service: "loses" } })),
    "wins",
  );
});

test("canonicalNameFor: case-insensitive label-key match", () => {
  assert.equal(
    canonicalNameFor(r("x", "deployment", { labels: { "App": "Yes" } })),
    "yes",
  );
});

test("canonicalNameFor: returns undefined when no canonical signal present", () => {
  assert.equal(canonicalNameFor(r("x", "deployment")), undefined);
  assert.equal(canonicalNameFor(r("x", "deployment", { labels: { tier: "frontend" } })), undefined);
});

test("mergeTopologies: empty input returns empty result", () => {
  const m = mergeTopologies([]);
  assert.deepEqual(m.resources, []);
  assert.deepEqual(m.edges, []);
  assert.equal(m.idMap.size, 0);
});

test("mergeTopologies: passes resources without canonical name unchanged", () => {
  const s = snap([r("a", "node", { source: "k8s" }), r("b", "namespace", { source: "k8s" })]);
  const m = mergeTopologies([s]);
  assert.equal(m.resources.length, 2);
  assert.equal(m.idMap.size, 0);
});

test("mergeTopologies: collapses k8s Deployment + cloud_service with same canonical name", () => {
  const k8s = snap([r("dep-payment", "deployment", { source: "k8s", labels: { app: "payment" } })]);
  const aws = snap([r("ecs-payment", "cloud_service", { source: "aws", canonical: "payment" })]);
  const m = mergeTopologies([k8s, aws]);
  assert.equal(m.resources.length, 1, "two providers, one canonical service");
  const merged = m.resources[0];
  // Higher-priority kind wins (cloud_service > deployment)
  assert.equal(merged.kind, "cloud_service");
  assert.deepEqual((merged.attributes?.mergedFrom as string[]).sort(), [
    "aws:ecs-payment",
    "k8s:dep-payment",
  ]);
  // idMap maps the non-canonical id to the canonical one (first by
  // source asc, then id asc: aws < k8s, so aws's id wins).
  assert.equal(merged.id, "ecs-payment");
  assert.equal(m.idMap.get("dep-payment"), "ecs-payment");
});

test("mergeTopologies: incompatible kinds in the bucket → no merge (graph stays verbose)", () => {
  // `pod` and `function` are not in MERGEABLE_KIND_PAIRS — even if
  // the names collide we keep both.
  const k8s = snap([r("p1", "pod", { source: "k8s", labels: { app: "payment" } })]);
  const aws = snap([r("fn1", "function", { source: "aws", canonical: "payment" })]);
  const m = mergeTopologies([k8s, aws]);
  assert.equal(m.resources.length, 2);
  assert.equal(m.idMap.size, 0);
});

test("mergeTopologies: rewrites edges that referenced a collapsed id", () => {
  const k8s = snap(
    [r("dep-payment", "deployment", { source: "k8s", labels: { app: "payment" } })],
    [e("pod-1", "dep-payment", "RUNS_AS", "k8s")],
  );
  const aws = snap(
    [r("ecs-payment", "cloud_service", { source: "aws", canonical: "payment" })],
    [e("ecs-payment", "rds-1", "READS_FROM", "aws")],
  );
  const m = mergeTopologies([k8s, aws]);
  // dep-payment was collapsed into ecs-payment
  const edges = m.edges;
  // The k8s edge's TO endpoint must be rewritten to ecs-payment.
  assert.ok(edges.some((x) => x.from === "pod-1" && x.to === "ecs-payment"));
  // The aws edge stays put.
  assert.ok(edges.some((x) => x.from === "ecs-payment" && x.to === "rds-1"));
});

test("mergeTopologies: self-loops created by the collapse are dropped", () => {
  // Two resources merge into one. An edge that pointed from A to B
  // becomes A→A after rewrite; drop it.
  const k8s = snap(
    [
      r("dep-payment", "deployment", { source: "k8s", labels: { app: "payment" } }),
      r("ecs-payment", "cloud_service", { source: "aws", canonical: "payment" }),
    ],
    [e("dep-payment", "ecs-payment", "ALIAS_OF", "synthetic")],
  );
  const m = mergeTopologies([k8s]);
  assert.equal(m.resources.length, 1);
  assert.equal(
    m.edges.filter((x) => x.from === x.to).length,
    0,
    "self-loops after collapse must be removed",
  );
});

test("mergeTopologies: duplicate (from,to,relation) tuples deduped after rewrite", () => {
  const k8s = snap(
    [
      r("a", "deployment", { source: "k8s", labels: { app: "payment" } }),
      r("b", "cloud_service", { source: "aws", canonical: "payment" }),
      r("client", "deployment", { source: "k8s" }),
    ],
    [
      e("client", "a", "CALLS", "k8s"),
      e("client", "b", "CALLS", "aws"),
    ],
  );
  const m = mergeTopologies([k8s]);
  // After collapse, both edges become client→b CALLS — dedup to one.
  const callEdges = m.edges.filter((x) => x.relation === "CALLS");
  assert.equal(callEdges.length, 1);
});
