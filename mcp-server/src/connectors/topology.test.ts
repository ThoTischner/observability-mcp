import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTopologyProvider, type ObservabilityConnector } from "./interface.js";
import type {
  Resource,
  Edge,
  TopologyChangeEvent,
  TopologySnapshot,
} from "../types.js";

// A minimal connector that exposes no topology methods.
function makeMetricsOnlyConnector(): ObservabilityConnector {
  return {
    name: "m1",
    type: "prometheus",
    signalType: "metrics",
    async connect() {},
    async healthCheck() {
      return { status: "up", latencyMs: 0 };
    },
    async disconnect() {},
    getDefaultMetrics() {
      return [];
    },
    getMetrics() {
      return [];
    },
    async listServices() {
      return [];
    },
  };
}

// A fake topology connector that returns a tiny, well-formed graph.
function makeTopologyConnector(): ObservabilityConnector {
  const resources: Resource[] = [
    {
      id: "k8s:pod:default/checkout-7f89d",
      kind: "pod",
      name: "checkout-7f89d",
      source: "kind-cluster",
      labels: { app: "checkout" },
      attributes: { uid: "11111111-1111-1111-1111-111111111111" },
    },
    {
      id: "k8s:node:worker-1",
      kind: "node",
      name: "worker-1",
      source: "kind-cluster",
      labels: {},
    },
  ];
  const edges: Edge[] = [
    {
      from: "k8s:pod:default/checkout-7f89d",
      to: "k8s:node:worker-1",
      relation: "RUNS_ON",
      source: "kind-cluster",
      confidence: 1.0,
    },
  ];
  return {
    name: "kind-cluster",
    type: "kubernetes",
    signalType: "topology",
    async connect() {},
    async healthCheck() {
      return { status: "up", latencyMs: 0 };
    },
    async disconnect() {},
    getDefaultMetrics() {
      return [];
    },
    getMetrics() {
      return [];
    },
    async listServices() {
      return [];
    },
    async listResources() {
      return resources;
    },
    async listEdges() {
      return edges;
    },
    async getTopologySnapshot(): Promise<TopologySnapshot> {
      return { source: "kind-cluster", resources, edges, revision: 1 };
    },
    watchTopology(listener) {
      // emit an initial resync, then a no-op unsubscribe
      queueMicrotask(() =>
        listener({
          type: "resync",
          snapshot: { source: "kind-cluster", resources, edges, revision: 1 },
        }),
      );
      return () => {};
    },
  };
}

describe("isTopologyProvider", () => {
  it("returns false for metrics-only connectors", () => {
    assert.equal(isTopologyProvider(makeMetricsOnlyConnector()), false);
  });

  it("returns true when all four topology methods are present", () => {
    assert.equal(isTopologyProvider(makeTopologyConnector()), true);
  });

  it("returns false if any topology method is missing", () => {
    const conn = makeTopologyConnector();
    // Strip one method — partial topology support is not a TopologyProvider.
    delete (conn as Partial<ObservabilityConnector>).watchTopology;
    assert.equal(isTopologyProvider(conn), false);
  });
});

describe("topology data model", () => {
  it("Resource.id follows the k8s:<kind>:<namespace>/<name> shape for namespaced kinds", async () => {
    const conn = makeTopologyConnector();
    assert.ok(isTopologyProvider(conn));
    const resources = await conn.listResources();
    const pod = resources.find((r) => r.kind === "pod");
    assert.ok(pod, "expected a pod resource");
    assert.match(pod.id, /^k8s:pod:[^/]+\/.+$/);
  });

  it("Resource.id for cluster-scoped kinds has no namespace segment", async () => {
    const conn = makeTopologyConnector();
    assert.ok(isTopologyProvider(conn));
    const resources = await conn.listResources();
    const node = resources.find((r) => r.kind === "node");
    assert.ok(node, "expected a node resource");
    assert.match(node.id, /^k8s:node:[^/]+$/);
  });

  it("every Resource and Edge carries a non-empty source", async () => {
    const conn = makeTopologyConnector();
    assert.ok(isTopologyProvider(conn));
    const snap = await conn.getTopologySnapshot();
    for (const r of snap.resources) assert.ok(r.source.length > 0);
    for (const e of snap.edges) assert.ok(e.source.length > 0);
  });

  it("Edge endpoints reference existing Resource ids", async () => {
    const conn = makeTopologyConnector();
    assert.ok(isTopologyProvider(conn));
    const snap = await conn.getTopologySnapshot();
    const ids = new Set(snap.resources.map((r) => r.id));
    for (const e of snap.edges) {
      assert.ok(ids.has(e.from), `dangling edge.from: ${e.from}`);
      assert.ok(ids.has(e.to), `dangling edge.to: ${e.to}`);
    }
  });

  it("confidence is bounded to [0,1]", async () => {
    const conn = makeTopologyConnector();
    assert.ok(isTopologyProvider(conn));
    const edges = await conn.listEdges();
    for (const e of edges) {
      assert.ok(e.confidence >= 0 && e.confidence <= 1);
    }
  });
});

describe("watchTopology", () => {
  it("delivers a resync event with the current snapshot", async () => {
    const conn = makeTopologyConnector();
    assert.ok(isTopologyProvider(conn));
    const events: TopologyChangeEvent[] = [];
    const unsubscribe = conn.watchTopology((e) => events.push(e));
    // Allow the queued microtask to fire.
    await new Promise((resolve) => setImmediate(resolve));
    unsubscribe();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "resync");
    if (events[0].type === "resync") {
      assert.ok(events[0].snapshot.revision >= 1);
    }
  });
});
