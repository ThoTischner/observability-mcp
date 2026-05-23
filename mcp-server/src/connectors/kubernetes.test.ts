import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KubernetesConnector, type Informer, type InformerFactory } from "./kubernetes.js";
import { isTopologyProvider } from "./interface.js";
import type {
  KubePod,
  KubeNode,
  KubeDeployment,
  KubeReplicaSet,
  KubeNamespace,
} from "./kubernetes-graph.js";
import type { SourceConfig, TopologyChangeEvent } from "../types.js";

// --- Fake informer harness ---------------------------------------------
// We hand-roll a tiny event emitter so tests can drive add/update/delete
// events synchronously without spinning up a real watch stream.

type Handler<T> = (obj: T) => void;
type EvtName = "add" | "update" | "delete" | "error";

class FakeInformer<T> implements Informer<T> {
  private handlers: Partial<Record<EvtName, Array<Handler<T> | ((e: unknown) => void)>>> = {};
  started = false;
  stopped = false;

  on(event: EvtName, handler: Handler<T> | ((e: unknown) => void)): void {
    (this.handlers[event] ??= []).push(handler);
  }
  async start() {
    this.started = true;
  }
  async stop() {
    this.stopped = true;
  }

  emit(event: "add" | "update" | "delete", obj: T): void {
    for (const h of this.handlers[event] ?? []) (h as Handler<T>)(obj);
  }
}

function makeFakeFactory() {
  const pods = new FakeInformer<KubePod>();
  const nodes = new FakeInformer<KubeNode>();
  const deps = new FakeInformer<KubeDeployment>();
  const rs = new FakeInformer<KubeReplicaSet>();
  const ns = new FakeInformer<KubeNamespace>();
  const factory: InformerFactory = {
    pods: () => pods,
    nodes: () => nodes,
    deployments: () => deps,
    replicaSets: () => rs,
    namespaces: () => ns,
    async healthCheck() {
      return { ok: true, latencyMs: 1 };
    },
    async close() {},
  };
  return { factory, pods, nodes, deps, rs, ns };
}

const CFG: SourceConfig = {
  name: "test-cluster",
  type: "kubernetes",
  url: "",
  enabled: true,
};

describe("KubernetesConnector", () => {
  it("implements the TopologyProvider capability", async () => {
    const { factory } = makeFakeFactory();
    const conn = new KubernetesConnector(async () => factory);
    await conn.connect(CFG);
    assert.equal(isTopologyProvider(conn), true);
    assert.equal(conn.signalType, "topology");
    await conn.disconnect();
  });

  it("starts every informer on connect and stops them on disconnect", async () => {
    const fake = makeFakeFactory();
    const conn = new KubernetesConnector(async () => fake.factory);
    await conn.connect(CFG);
    for (const inf of [fake.pods, fake.nodes, fake.deps, fake.rs, fake.ns]) {
      assert.equal(inf.started, true);
    }
    await conn.disconnect();
    for (const inf of [fake.pods, fake.nodes, fake.deps, fake.rs, fake.ns]) {
      assert.equal(inf.stopped, true);
    }
  });

  it("builds the graph from watch events", async () => {
    const fake = makeFakeFactory();
    const conn = new KubernetesConnector(async () => fake.factory);
    await conn.connect(CFG);

    fake.nodes.emit("add", { metadata: { name: "worker-1" } });
    fake.ns.emit("add", { metadata: { name: "default" } });
    fake.deps.emit("add", { metadata: { name: "checkout", namespace: "default" } });
    fake.rs.emit("add", {
      metadata: {
        name: "checkout-7f89",
        namespace: "default",
        ownerReferences: [{ kind: "Deployment", name: "checkout" }],
      },
    });
    fake.pods.emit("add", {
      metadata: {
        name: "checkout-7f89d",
        namespace: "default",
        ownerReferences: [{ kind: "ReplicaSet", name: "checkout-7f89" }],
      },
      spec: { nodeName: "worker-1" },
    });

    const snap = await conn.getTopologySnapshot();
    const ids = snap.resources.map((r) => r.id).sort();
    assert.deepEqual(ids, [
      "k8s:deployment:default/checkout",
      "k8s:namespace:default",
      "k8s:node:worker-1",
      "k8s:pod:default/checkout-7f89d",
      "k8s:replicaset:default/checkout-7f89",
    ]);
    // Full RCA chain present: pod → rs → deployment, pod → node, * → namespace.
    const e = snap.edges;
    assert.ok(e.some((x) => x.from === "k8s:pod:default/checkout-7f89d" && x.relation === "RUNS_ON"));
    assert.ok(e.some((x) => x.from === "k8s:pod:default/checkout-7f89d" && x.relation === "OWNED_BY"));
    assert.ok(e.some((x) => x.from === "k8s:replicaset:default/checkout-7f89" && x.relation === "OWNED_BY"));
    await conn.disconnect();
  });

  it("removes a pod's edges when the pod is deleted", async () => {
    const fake = makeFakeFactory();
    const conn = new KubernetesConnector(async () => fake.factory);
    await conn.connect(CFG);
    const pod: KubePod = {
      metadata: { name: "p1", namespace: "default" },
      spec: { nodeName: "n1" },
    };
    fake.pods.emit("add", pod);
    assert.equal((await conn.listEdges()).length > 0, true);
    fake.pods.emit("delete", pod);
    assert.equal((await conn.listResources()).length, 0);
    assert.equal((await conn.listEdges()).length, 0);
    await conn.disconnect();
  });

  it("watchTopology delivers a resync then live diffs", async () => {
    const fake = makeFakeFactory();
    const conn = new KubernetesConnector(async () => fake.factory);
    await conn.connect(CFG);
    fake.nodes.emit("add", { metadata: { name: "n0" } });

    const events: TopologyChangeEvent[] = [];
    const unsub = conn.watchTopology((e) => events.push(e));
    await new Promise((r) => setImmediate(r));
    assert.equal(events[0]?.type, "resync");

    fake.nodes.emit("add", { metadata: { name: "n1" } });
    assert.ok(events.some((e) => e.type === "resource_added"));
    unsub();
    await conn.disconnect();
  });
});
