import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConnectorRegistry } from "../connectors/registry.js";
import { PluginLoader } from "../connectors/loader.js";
import type { ObservabilityConnector } from "../connectors/interface.js";
import type {
  Resource,
  Edge,
  TopologySnapshot,
  TopologyChangeListener,
  SourceConfig,
  ConnectorHealth,
  ServiceInfo,
  MetricDefinition,
} from "../types.js";
import {
  getTopologyHandler,
  getBlastRadiusHandler,
  resolveResource,
} from "./topology.js";

// --- A minimal stand-alone topology connector used as test fixture -----
// Lets the suite drive the tool handlers without a real K8s cluster.

class FakeTopologyConnector implements ObservabilityConnector {
  readonly type = "fake";
  readonly signalType = "topology" as const;
  name = "fake-cluster";
  private resources: Resource[];
  private edges: Edge[];

  constructor(resources: Resource[], edges: Edge[]) {
    this.resources = resources;
    this.edges = edges;
  }
  async connect(c: SourceConfig) { this.name = c.name; }
  async healthCheck(): Promise<ConnectorHealth> { return { status: "up", latencyMs: 1 }; }
  async disconnect() {}
  getDefaultMetrics(): MetricDefinition[] { return []; }
  getMetrics(): MetricDefinition[] { return []; }
  async listServices(): Promise<ServiceInfo[]> { return []; }
  async listResources(): Promise<Resource[]> { return this.resources; }
  async listEdges(): Promise<Edge[]> { return this.edges; }
  async getTopologySnapshot(): Promise<TopologySnapshot> {
    return { source: this.name, resources: this.resources, edges: this.edges, revision: 1 };
  }
  watchTopology(_l: TopologyChangeListener) { return () => {}; }
}

// Build a small but realistic topology covering both happy and edge cases:
// two services, two hosts, ownership chain, one orphan, one cross-kind link.
function fixture(): { resources: Resource[]; edges: Edge[] } {
  const r: Resource[] = [
    // Hosts
    { id: "k8s:node:n1", kind: "node", name: "n1", source: "fake", labels: {} },
    { id: "k8s:node:n2", kind: "node", name: "n2", source: "fake", labels: {} },
    // Scope
    { id: "k8s:namespace:prod", kind: "namespace", name: "prod", source: "fake", labels: {} },
    { id: "k8s:namespace:staging", kind: "namespace", name: "staging", source: "fake", labels: {} },
    // Ownership roots (deployments)
    { id: "k8s:deployment:prod/api", kind: "deployment", name: "api", source: "fake", labels: {} },
    { id: "k8s:deployment:prod/db",  kind: "deployment", name: "db",  source: "fake", labels: {} },
    // Intermediate
    { id: "k8s:replicaset:prod/api-1", kind: "replicaset", name: "api-1", source: "fake", labels: {} },
    // Workloads
    { id: "k8s:pod:prod/api-aaa", kind: "pod", name: "api-aaa", source: "fake", labels: { app: "api" } },
    { id: "k8s:pod:prod/api-bbb", kind: "pod", name: "api-bbb", source: "fake", labels: { app: "api" } },
    { id: "k8s:pod:prod/db-aaa",  kind: "pod", name: "db-aaa",  source: "fake", labels: { app: "db" } },
    // Orphan with no RUNS_ON (e.g. pending)
    { id: "k8s:pod:staging/pending-1", kind: "pod", name: "pending-1", source: "fake", labels: {} },
  ];
  const e: Edge[] = [
    // ownership chain
    { from: "k8s:pod:prod/api-aaa", to: "k8s:replicaset:prod/api-1", relation: "OWNED_BY", source: "fake", confidence: 1 },
    { from: "k8s:pod:prod/api-bbb", to: "k8s:replicaset:prod/api-1", relation: "OWNED_BY", source: "fake", confidence: 1 },
    { from: "k8s:replicaset:prod/api-1", to: "k8s:deployment:prod/api", relation: "OWNED_BY", source: "fake", confidence: 1 },
    { from: "k8s:pod:prod/db-aaa", to: "k8s:deployment:prod/db", relation: "OWNED_BY", source: "fake", confidence: 1 },
    // RUNS_ON — api-aaa shares n1 with db-aaa (blast-radius case);
    // api-bbb alone on n2 (no shared-host case)
    { from: "k8s:pod:prod/api-aaa", to: "k8s:node:n1", relation: "RUNS_ON", source: "fake", confidence: 1 },
    { from: "k8s:pod:prod/db-aaa",  to: "k8s:node:n1", relation: "RUNS_ON", source: "fake", confidence: 1 },
    { from: "k8s:pod:prod/api-bbb", to: "k8s:node:n2", relation: "RUNS_ON", source: "fake", confidence: 1 },
    // IN_NAMESPACE
    { from: "k8s:pod:prod/api-aaa", to: "k8s:namespace:prod", relation: "IN_NAMESPACE", source: "fake", confidence: 1 },
    { from: "k8s:pod:prod/api-bbb", to: "k8s:namespace:prod", relation: "IN_NAMESPACE", source: "fake", confidence: 1 },
    { from: "k8s:pod:prod/db-aaa",  to: "k8s:namespace:prod", relation: "IN_NAMESPACE", source: "fake", confidence: 1 },
    { from: "k8s:deployment:prod/api", to: "k8s:namespace:prod", relation: "IN_NAMESPACE", source: "fake", confidence: 1 },
    { from: "k8s:deployment:prod/db",  to: "k8s:namespace:prod", relation: "IN_NAMESPACE", source: "fake", confidence: 1 },
    { from: "k8s:replicaset:prod/api-1", to: "k8s:namespace:prod", relation: "IN_NAMESPACE", source: "fake", confidence: 1 },
    { from: "k8s:pod:staging/pending-1", to: "k8s:namespace:staging", relation: "IN_NAMESPACE", source: "fake", confidence: 1 },
  ];
  return { resources: r, edges: e };
}

async function makeRegistry(): Promise<ConnectorRegistry> {
  const { resources, edges } = fixture();
  const loader = new PluginLoader();
  // Don't load builtins/filesystem — we plug a single fake connector in
  // directly so the suite is hermetic and fast.
  const reg = new ConnectorRegistry(loader);
  const conn = new FakeTopologyConnector(resources, edges);
  await conn.connect({ name: "fake-cluster", type: "fake", url: "", enabled: true });
  // ConnectorRegistry has no public "register a live instance" method,
  // so we install via the documented addSource path with a fake loader.
  (loader as unknown as { connectors: Map<string, unknown> }).connectors.set("fake", {
    name: "fake",
    source: "builtin",
    factory: () => conn,
  });
  await reg.addSource({ name: "fake-cluster", type: "fake", url: "", enabled: true });
  return reg;
}

function parseTool(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("resolveResource", () => {
  const { resources } = fixture();
  it("matches an exact id", () => {
    const r = resolveResource("k8s:node:n1", resources);
    assert.ok(!("error" in r));
    if (!("error" in r)) assert.equal(r.kind, "node");
  });
  it("matches a unique exact name", () => {
    const r = resolveResource("api-aaa", resources);
    assert.ok(!("error" in r));
  });
  it("returns candidates for an ambiguous fuzzy match", () => {
    // "aaa" doesn't exactly match any name, but fuzzy-matches api-aaa and db-aaa
    const r = resolveResource("aaa", resources);
    assert.ok("error" in r);
    if ("error" in r) {
      assert.ok((r.candidates?.length ?? 0) >= 2);
    }
  });
  it("returns a clean error for no match", () => {
    const r = resolveResource("does-not-exist", resources);
    assert.ok("error" in r);
  });
});

describe("get_topology tool", () => {
  it("returns the full graph by default", async () => {
    const reg = await makeRegistry();
    const out = parseTool(await getTopologyHandler(reg, {}));
    assert.equal(out.sources.length, 1);
    assert.equal(out.resources.length, fixture().resources.length);
    assert.equal(out.edges.length, fixture().edges.length);
    assert.equal(out.truncated, false);
  });

  it("filters by kind", async () => {
    const reg = await makeRegistry();
    const out = parseTool(await getTopologyHandler(reg, { kind: "pod" }));
    for (const r of out.resources) assert.equal(r.kind, "pod");
    // edges must reference only the kept resources
    const ids = new Set<string>(out.resources.map((r: { id: string }) => r.id));
    for (const e of out.edges) {
      assert.ok(ids.has(e.from) && ids.has(e.to));
    }
  });

  it("filters by scope name or id", async () => {
    const reg = await makeRegistry();
    const byName = parseTool(await getTopologyHandler(reg, { scope: "prod" }));
    const byId = parseTool(await getTopologyHandler(reg, { scope: "k8s:namespace:prod" }));
    assert.equal(byName.resources.length, byId.resources.length);
    // staging pod must not appear
    assert.ok(!byName.resources.some((r: { name: string }) => r.name === "pending-1"));
  });

  it("respects the limit and reports truncation", async () => {
    const reg = await makeRegistry();
    const out = parseTool(await getTopologyHandler(reg, { limit: 3 }));
    assert.equal(out.resources.length, 3);
    assert.equal(out.truncated, true);
    assert.equal(out.total.resources, fixture().resources.length);
  });
});

describe("get_blast_radius tool", () => {
  it("reports shared-host blast radius for a co-located pod", async () => {
    const reg = await makeRegistry();
    const out = parseTool(await getBlastRadiusHandler(reg, { resource: "api-aaa" }));
    assert.equal(out.target.name, "api-aaa");
    assert.equal(out.hosts.length, 1);
    const host = out.hosts[0];
    assert.equal(host.host.name, "n1");
    // Two ownership roots on n1: deployment/api and deployment/db
    assert.equal(host.ownershipRoots, 2);
    const rootNames = new Set(host.coTenants.map((c: { ownershipRootName: string }) => c.ownershipRootName));
    assert.ok(rootNames.has("api"));
    assert.ok(rootNames.has("db"));
    assert.match(out.summary, /blast-radius candidate/i);
  });

  it("reports no shared-host for a pod alone on its node", async () => {
    const reg = await makeRegistry();
    const out = parseTool(await getBlastRadiusHandler(reg, { resource: "api-bbb" }));
    assert.equal(out.hosts.length, 1);
    assert.equal(out.hosts[0].host.name, "n2");
    assert.equal(out.hosts[0].ownershipRoots, 1);
    assert.match(out.summary, /limited shared-host/i);
  });

  it("treats a host resource as its own host (incoming RUNS_ON pivot)", async () => {
    const reg = await makeRegistry();
    const out = parseTool(await getBlastRadiusHandler(reg, { resource: "k8s:node:n1" }));
    assert.equal(out.target.kind, "node");
    assert.equal(out.hosts.length, 1);
    assert.equal(out.hosts[0].host.id, "k8s:node:n1");
  });

  it("returns a note when a resource has no RUNS_ON edges", async () => {
    const reg = await makeRegistry();
    const out = parseTool(await getBlastRadiusHandler(reg, { resource: "pending-1" }));
    assert.equal(out.hosts.length, 0);
    assert.match(out.note, /no RUNS_ON/i);
  });

  it("surfaces a structured error for unknown resources", async () => {
    const reg = await makeRegistry();
    const result = await getBlastRadiusHandler(reg, { resource: "totally-not-here" });
    assert.equal((result as { isError?: boolean }).isError, true);
    const out = parseTool(result);
    assert.match(out.error, /No resource found/);
  });

  it("uses ownership root, not direct owner, when grouping co-tenants", async () => {
    // api-aaa is OWNED_BY a ReplicaSet which is OWNED_BY a Deployment.
    // The blast-radius should bucket api-aaa under the Deployment, not the RS.
    const reg = await makeRegistry();
    const out = parseTool(await getBlastRadiusHandler(reg, { resource: "api-aaa" }));
    const onN1 = out.hosts[0];
    const apiBucket = onN1.coTenants.find((c: { ownershipRootName: string }) => c.ownershipRootName === "api");
    assert.ok(apiBucket, "expected an 'api' deployment bucket on n1");
    assert.equal(apiBucket.ownershipRootKind, "deployment");
  });
});

// --- Multi-source merge (Phase P1 wiring) ----------------------------
// `aggregateTopology` now delegates to `mergeTopologies` when 2+
// snapshots are present so the same logical workload reported by
// e.g. Kubernetes + a cloud connector collapses into one node.
// Single-snapshot calls pass through unchanged (guarded so we don't
// mis-merge intra-source siblings that share an `app:` label).

describe("aggregateTopology — multi-source merger (P1 wire)", () => {
  it("collapses cross-source duplicates that share a canonical label", async () => {
    // Source A (k8s): one Deployment "checkout" in prod
    const aRes: Resource[] = [
      { id: "k8s:deployment:prod/checkout", kind: "deployment", name: "checkout", source: "k8s",
        labels: { "app.kubernetes.io/name": "checkout" } },
    ];
    // Source B (trace provider): the same logical service
    const bRes: Resource[] = [
      { id: "tempo:service:checkout", kind: "trace_service", name: "checkout", source: "tempo",
        labels: { "service.name": "checkout" } },
    ];

    const loader = new PluginLoader();
    const reg = new ConnectorRegistry(loader);
    const connA = new FakeTopologyConnector(aRes, []);
    const connB = new FakeTopologyConnector(bRes, []);
    await connA.connect({ name: "k8s", type: "fake", url: "", enabled: true });
    await connB.connect({ name: "tempo", type: "fake", url: "", enabled: true });
    const loaderInternal = loader as unknown as { connectors: Map<string, unknown> };
    loaderInternal.connectors.set("fake-a", { name: "fake-a", source: "builtin", factory: () => connA });
    loaderInternal.connectors.set("fake-b", { name: "fake-b", source: "builtin", factory: () => connB });
    await reg.addSource({ name: "k8s", type: "fake-a", url: "", enabled: true });
    await reg.addSource({ name: "tempo", type: "fake-b", url: "", enabled: true });

    const out = parseTool(await getTopologyHandler(reg, {}));
    // 2 sources reported in summary
    assert.equal(out.sources.length, 2);
    // But ONE resource after merge (deployment + trace_service of the
    // same canonical name collapse via MERGEABLE_KIND_PAIRS).
    assert.equal(out.resources.length, 1);
    assert.equal(out.resources[0].name, "checkout");
  });

  it("single-source passes through unchanged (no intra-source merging)", async () => {
    // The existing 4-pod fixture has two pods sharing `app: api`.
    // With a single snapshot the merger must NOT collapse them.
    const reg = await makeRegistry();
    const out = parseTool(await getTopologyHandler(reg, {}));
    assert.equal(out.resources.length, fixture().resources.length);
  });
});
