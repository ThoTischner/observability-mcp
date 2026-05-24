import type { ObservabilityConnector } from "./interface.js";
import type {
  SourceConfig,
  ConnectorHealth,
  ServiceInfo,
  MetricDefinition,
  Resource,
  Edge,
  TopologySnapshot,
  TopologyChangeListener,
  SignalType,
} from "../types.js";
import {
  TopologyStore,
  podResource,
  podEdges,
  nodeResource,
  deploymentResource,
  deploymentEdges,
  replicaSetResource,
  replicaSetEdges,
  namespaceResource,
  namespacedId,
  clusterScopedId,
  type KubePod,
  type KubeNode,
  type KubeDeployment,
  type KubeReplicaSet,
  type KubeNamespace,
} from "./kubernetes-graph.js";
import { validateSnapshot } from "./topology-vocabulary.js";

// Minimal informer abstraction so the connector is unit-testable without
// a live cluster. The real implementation in createInformerFactory wraps
// @kubernetes/client-node's makeInformer; the test suite swaps in a fake
// factory and drives events synchronously.
export interface Informer<T> {
  on(event: "add" | "update", handler: (obj: T) => void): void;
  on(event: "delete", handler: (obj: T) => void): void;
  on(event: "error", handler: (err: unknown) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface InformerFactory {
  pods(): Informer<KubePod>;
  nodes(): Informer<KubeNode>;
  deployments(): Informer<KubeDeployment>;
  replicaSets(): Informer<KubeReplicaSet>;
  namespaces(): Informer<KubeNamespace>;
  /** Cheap health probe — should hit /version or /healthz. */
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; message?: string }>;
  close(): Promise<void>;
}

export type InformerFactoryProvider = (config: SourceConfig) => Promise<InformerFactory>;

// Default provider is loaded lazily so tests don't pay the
// @kubernetes/client-node import cost (and so the module is usable in
// environments where the SDK isn't installed yet — e.g. unit tests in CI
// before the dep lands).
let defaultProvider: InformerFactoryProvider | undefined;

export function setDefaultInformerFactoryProvider(p: InformerFactoryProvider): void {
  defaultProvider = p;
}

async function loadDefaultProvider(): Promise<InformerFactoryProvider> {
  if (defaultProvider) return defaultProvider;
  const mod = await import("./kubernetes-client.js");
  defaultProvider = mod.createInformerFactory;
  return defaultProvider;
}

export class KubernetesConnector implements ObservabilityConnector {
  readonly type = "kubernetes";
  readonly signalType: SignalType = "topology";

  name = "";
  private store!: TopologyStore;
  private warnedVocab = new Set<string>();
  private factory?: InformerFactory;
  private informers: Informer<unknown>[] = [];
  private providerOverride?: InformerFactoryProvider;

  /** Constructor injection used by tests. */
  constructor(provider?: InformerFactoryProvider) {
    this.providerOverride = provider;
  }

  async connect(config: SourceConfig): Promise<void> {
    this.name = config.name;
    this.store = new TopologyStore(config.name);
    const provider = this.providerOverride ?? (await loadDefaultProvider());
    this.factory = await provider(config);

    // Wire each informer to the store. Pure builders translate Kube
    // objects → Resource/Edge; the store dedupes and emits diffs.
    const pods = this.factory.pods();
    pods.on("add", (p) => this.applyPod(p));
    pods.on("update", (p) => this.applyPod(p));
    pods.on("delete", (p) => {
      const id = idOfPod(p);
      if (id) this.store.removeResource(id);
    });
    pods.on("error", (err) => logWatchError(this.name, "pods", err));

    const nodes = this.factory.nodes();
    nodes.on("add", (n) => this.applyNode(n));
    nodes.on("update", (n) => this.applyNode(n));
    nodes.on("delete", (n) => {
      const id = idOfNode(n);
      if (id) this.store.removeResource(id);
    });
    nodes.on("error", (err) => logWatchError(this.name, "nodes", err));

    const deps = this.factory.deployments();
    deps.on("add", (d) => this.applyDeployment(d));
    deps.on("update", (d) => this.applyDeployment(d));
    deps.on("delete", (d) => {
      const id = idOfNamespaced("deployment", d);
      if (id) this.store.removeResource(id);
    });
    deps.on("error", (err) => logWatchError(this.name, "deployments", err));

    const rs = this.factory.replicaSets();
    rs.on("add", (r) => this.applyReplicaSet(r));
    rs.on("update", (r) => this.applyReplicaSet(r));
    rs.on("delete", (r) => {
      const id = idOfNamespaced("replicaset", r);
      if (id) this.store.removeResource(id);
    });
    rs.on("error", (err) => logWatchError(this.name, "replicasets", err));

    const ns = this.factory.namespaces();
    ns.on("add", (n) => this.applyNamespace(n));
    ns.on("update", (n) => this.applyNamespace(n));
    ns.on("delete", (n) => {
      const name = n.metadata?.name;
      if (name) this.store.removeResource(clusterScopedId("namespace", name));
    });
    ns.on("error", (err) => logWatchError(this.name, "namespaces", err));

    this.informers = [pods, nodes, deps, rs, ns];
    await Promise.all(this.informers.map((i) => i.start()));
  }

  private applyPod(p: KubePod): void {
    const r = podResource(this.name, p);
    if (!r) return;
    this.store.upsertResource(r, podEdges(this.name, p));
  }

  private applyNode(n: KubeNode): void {
    const r = nodeResource(this.name, n);
    if (!r) return;
    this.store.upsertResource(r, []);
  }

  private applyDeployment(d: KubeDeployment): void {
    const r = deploymentResource(this.name, d);
    if (!r) return;
    this.store.upsertResource(r, deploymentEdges(this.name, d));
  }

  private applyReplicaSet(rs: KubeReplicaSet): void {
    const r = replicaSetResource(this.name, rs);
    if (!r) return;
    this.store.upsertResource(r, replicaSetEdges(this.name, rs));
  }

  private applyNamespace(n: KubeNamespace): void {
    const r = namespaceResource(this.name, n);
    if (!r) return;
    this.store.upsertResource(r, []);
  }

  async healthCheck(): Promise<ConnectorHealth> {
    if (!this.factory) return { status: "down", latencyMs: 0, message: "not connected" };
    const r = await this.factory.healthCheck();
    return { status: r.ok ? "up" : "down", latencyMs: r.latencyMs, message: r.message };
  }

  async disconnect(): Promise<void> {
    await Promise.all(this.informers.map((i) => i.stop().catch(() => {})));
    this.informers = [];
    await this.factory?.close().catch(() => {});
    this.factory = undefined;
  }

  // Topology has no metric/service surface — these stay empty/inert.
  getDefaultMetrics(): MetricDefinition[] {
    return [];
  }
  getMetrics(): MetricDefinition[] {
    return [];
  }
  async listServices(): Promise<ServiceInfo[]> {
    return [];
  }

  // --- Topology capability ---
  async listResources(): Promise<Resource[]> {
    return this.store?.listResources() ?? [];
  }
  async listEdges(): Promise<Edge[]> {
    return this.store?.listEdges() ?? [];
  }
  async getTopologySnapshot(): Promise<TopologySnapshot> {
    const snap = this.store?.snapshot() ?? {
      source: this.name,
      resources: [],
      edges: [],
      revision: 0,
    };
    for (const w of validateSnapshot(snap.resources, snap.edges)) {
      const key = `${w.kind}:${w.value}`;
      if (this.warnedVocab.has(key)) continue;
      this.warnedVocab.add(key);
      console.warn("topology vocabulary warning (source=%s): %s", this.name, w.message);
    }
    return snap;
  }
  watchTopology(listener: TopologyChangeListener): () => void {
    if (!this.store) return () => {};
    // Initial resync so subscribers see the current state without
    // racing the next watch event.
    queueMicrotask(() => listener({ type: "resync", snapshot: this.store.snapshot() }));
    return this.store.subscribe(listener);
  }
}

// --- helpers ---

function idOfPod(p: KubePod): string | undefined {
  const n = p.metadata?.name;
  const ns = p.metadata?.namespace;
  if (!n || !ns) return undefined;
  return namespacedId("pod", ns, n);
}

function idOfNode(n: KubeNode): string | undefined {
  return n.metadata?.name ? clusterScopedId("node", n.metadata.name) : undefined;
}

function idOfNamespaced(
  kind: string,
  obj: { metadata?: { name?: string; namespace?: string } },
): string | undefined {
  const n = obj.metadata?.name;
  const ns = obj.metadata?.namespace;
  if (!n || !ns) return undefined;
  return namespacedId(kind, ns, n);
}

function logWatchError(source: string, kind: string, err: unknown): void {
  // AbortError is what makeInformer emits when we cleanly stop the watch
  // (disconnect, process shutdown) — not actually an error to surface.
  const msg = String(err);
  if (msg.includes("AbortError") || /aborted a request/i.test(msg)) return;
  console.warn("k8s watch error: source=%s kind=%s err=%s", source, kind, msg);
}
