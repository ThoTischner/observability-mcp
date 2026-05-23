import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TopologyStore,
  podResource,
  podEdges,
  nodeResource,
  deploymentResource,
  replicaSetResource,
  replicaSetEdges,
  namespacedId,
  clusterScopedId,
  type KubePod,
} from "./kubernetes-graph.js";

const SRC = "test-cluster";

const samplePod: KubePod = {
  metadata: {
    name: "checkout-7f89d",
    namespace: "default",
    uid: "pod-uid-1",
    labels: { app: "checkout" },
    ownerReferences: [{ kind: "ReplicaSet", name: "checkout-7f89", uid: "rs-uid-1" }],
  },
  spec: { nodeName: "worker-1" },
  status: { phase: "Running" },
};

describe("kubernetes-graph: resource builders", () => {
  it("podResource produces a stable namespaced ID and preserves labels/uid", () => {
    const r = podResource(SRC, samplePod);
    assert.ok(r);
    assert.equal(r!.id, "k8s:pod:default/checkout-7f89d");
    assert.equal(r!.kind, "pod");
    assert.equal(r!.source, SRC);
    assert.deepEqual(r!.labels, { app: "checkout" });
    assert.equal((r!.attributes as { uid?: string }).uid, "pod-uid-1");
    assert.equal((r!.attributes as { phase?: string }).phase, "Running");
  });

  it("returns undefined when metadata is missing", () => {
    assert.equal(podResource(SRC, {}), undefined);
    assert.equal(podResource(SRC, { metadata: { name: "x" } }), undefined); // no namespace
  });

  it("nodeResource is cluster-scoped (no namespace in ID)", () => {
    const r = nodeResource(SRC, {
      metadata: { name: "worker-1" },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    });
    assert.equal(r!.id, "k8s:node:worker-1");
    assert.equal((r!.attributes as { ready?: string }).ready, "True");
  });

  it("deploymentResource builds a namespaced ID", () => {
    const r = deploymentResource(SRC, {
      metadata: { name: "checkout", namespace: "default" },
    });
    assert.equal(r!.id, "k8s:deployment:default/checkout");
  });

  it("replicaSetResource builds a namespaced ID", () => {
    const r = replicaSetResource(SRC, {
      metadata: { name: "checkout-7f89", namespace: "default" },
    });
    assert.equal(r!.id, "k8s:replicaset:default/checkout-7f89");
  });
});

describe("kubernetes-graph: edge builders", () => {
  it("podEdges emits RUNS_ON, IN_NAMESPACE and OWNED_BY", () => {
    const edges = podEdges(SRC, samplePod);
    const rels = edges.map((e) => e.relation).sort();
    assert.deepEqual(rels, ["IN_NAMESPACE", "OWNED_BY", "RUNS_ON"]);
    const runs = edges.find((e) => e.relation === "RUNS_ON");
    assert.equal(runs!.to, "k8s:node:worker-1");
    assert.equal(runs!.confidence, 1.0);
    assert.equal(runs!.source, SRC);
    const owned = edges.find((e) => e.relation === "OWNED_BY");
    assert.equal(owned!.to, "k8s:replicaset:default/checkout-7f89");
  });

  it("podEdges skips RUNS_ON when the pod has no nodeName yet (Pending)", () => {
    const pending: KubePod = {
      metadata: { name: "p", namespace: "default" },
      status: { phase: "Pending" },
    };
    const edges = podEdges(SRC, pending);
    assert.equal(edges.find((e) => e.relation === "RUNS_ON"), undefined);
    assert.ok(edges.find((e) => e.relation === "IN_NAMESPACE"));
  });

  it("replicaSetEdges chains OWNED_BY to a Deployment", () => {
    const edges = replicaSetEdges(SRC, {
      metadata: {
        name: "checkout-7f89",
        namespace: "default",
        ownerReferences: [{ kind: "Deployment", name: "checkout" }],
      },
    });
    const owned = edges.find((e) => e.relation === "OWNED_BY");
    assert.ok(owned);
    assert.equal(owned!.to, "k8s:deployment:default/checkout");
  });

  it("ignores unknown owner kinds (forward-compat)", () => {
    const edges = podEdges(SRC, {
      metadata: {
        name: "p",
        namespace: "default",
        ownerReferences: [{ kind: "FrobnicatorSet", name: "x" }],
      },
    });
    assert.equal(edges.find((e) => e.relation === "OWNED_BY"), undefined);
  });
});

describe("TopologyStore", () => {
  it("upsertResource adds resource + edges and emits diffs", () => {
    const store = new TopologyStore(SRC);
    const events: string[] = [];
    store.subscribe((e) => events.push(e.type));

    const r = podResource(SRC, samplePod)!;
    store.upsertResource(r, podEdges(SRC, samplePod));
    assert.equal(store.listResources().length, 1);
    assert.equal(store.listEdges().length, 3);
    assert.ok(events.includes("resource_added"));
    assert.equal(events.filter((t) => t === "edge_added").length, 3);
    assert.ok(store.revision > 0);
  });

  it("update replaces edges atomically — emits removed/added for diff only", () => {
    const store = new TopologyStore(SRC);
    store.upsertResource(podResource(SRC, samplePod)!, podEdges(SRC, samplePod));
    const events: string[] = [];
    store.subscribe((e) => events.push(e.type));

    // Pod moved to a new node — RUNS_ON edge should be replaced, others stable.
    const moved: KubePod = { ...samplePod, spec: { nodeName: "worker-2" } };
    store.upsertResource(podResource(SRC, moved)!, podEdges(SRC, moved));

    assert.equal(events.filter((t) => t === "edge_added").length, 1);
    assert.equal(events.filter((t) => t === "edge_removed").length, 1);
    assert.equal(events.filter((t) => t === "resource_updated").length, 1);

    const runs = store.listEdges().find((e) => e.relation === "RUNS_ON");
    assert.equal(runs!.to, "k8s:node:worker-2");
  });

  it("removeResource drops the resource and all its outgoing edges", () => {
    const store = new TopologyStore(SRC);
    store.upsertResource(podResource(SRC, samplePod)!, podEdges(SRC, samplePod));
    const id = namespacedId("pod", "default", "checkout-7f89d");
    store.removeResource(id);
    assert.equal(store.listResources().length, 0);
    assert.equal(store.listEdges().length, 0);
  });

  it("snapshot() carries the current revision counter", () => {
    const store = new TopologyStore(SRC);
    const r0 = store.revision;
    store.upsertResource(nodeResource(SRC, { metadata: { name: "n1" } })!, []);
    const snap = store.snapshot();
    assert.ok(snap.revision > r0);
    assert.equal(snap.source, SRC);
    assert.equal(snap.resources[0].id, clusterScopedId("node", "n1"));
  });

  it("subscriber errors don't kill the store", () => {
    const store = new TopologyStore(SRC);
    store.subscribe(() => {
      throw new Error("boom");
    });
    let saw = 0;
    store.subscribe(() => saw++);
    store.upsertResource(nodeResource(SRC, { metadata: { name: "n1" } })!, []);
    assert.ok(saw > 0);
  });
});
