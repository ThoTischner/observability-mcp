import { test } from "node:test";
import assert from "node:assert/strict";

import create, { GcpConnector } from "./index.js";

// Build fake GCP SDK clients. Each method returns a plain JS shape
// matching the real client surface enough to drive _buildSnapshot.
function fakeClients({ instances = {}, services = [], clusters = [] } = {}) {
  return {
    _compute: {
      aggregatedList: async () => instances,
      list: async () => [[], {}],
    },
    _run: {
      listServices: async () => services,
    },
    _container: {
      listClusters: async () => ({ clusters }),
    },
  };
}

async function makeConnector(extra = {}) {
  const c = create();
  await c.connect({
    name: "gcp-test",
    project: "demo-proj",
    region: "us-central1",
    ...fakeClients(extra),
  });
  return c;
}

test("create() returns GcpConnector with signalType topology", () => {
  const c = create();
  assert.ok(c instanceof GcpConnector);
  assert.equal(c.signalType, "topology");
});

test("connect resolves project from env when not in config", async () => {
  process.env.GOOGLE_CLOUD_PROJECT = "env-proj";
  const c = create();
  await c.connect({ name: "gcp", ...fakeClients() });
  assert.equal(c._project, "env-proj");
  delete process.env.GOOGLE_CLOUD_PROJECT;
});

test("connect without project + without test clients records sdkLoadError", async () => {
  delete process.env.GOOGLE_CLOUD_PROJECT;
  delete process.env.GCLOUD_PROJECT;
  const c = create();
  await c.connect({ name: "gcp" });
  assert.match(c._sdkLoadError, /GOOGLE_CLOUD_PROJECT not set/);
});

test("healthCheck down when sdk failed to load", async () => {
  const c = create();
  await c.connect({ name: "gcp" });
  const h = await c.healthCheck();
  assert.equal(h.status, "down");
  assert.match(h.message, /sdk not installed|not set/);
});

test("healthCheck up against fake clients", async () => {
  const c = await makeConnector();
  const h = await c.healthCheck();
  assert.equal(h.status, "up");
});

test("healthCheck down when SDK throws", async () => {
  const c = create();
  await c.connect({
    name: "gcp",
    project: "p",
    _compute: { list: async () => { throw new Error("permission denied"); }, aggregatedList: async () => ({}) },
    _run: { listServices: async () => [[]] },
    _container: { listClusters: async () => ({ clusters: [] }) },
  });
  const h = await c.healthCheck();
  assert.equal(h.status, "down");
  assert.match(h.message, /permission/);
});

test("empty topology snapshot", async () => {
  const c = await makeConnector();
  const snap = await c.getTopologySnapshot();
  assert.deepEqual(snap.resources, []);
  assert.deepEqual(snap.edges, []);
  assert.equal(snap.source, "gcp-test");
});

test("Compute Engine instances → cloud_node resources", async () => {
  const c = await makeConnector({
    instances: {
      "zones/us-central1-a": {
        instances: [
          { name: "web-1", machineType: "zones/us-central1-a/machineTypes/n2-standard-2", status: "RUNNING" },
          { name: "db-1", machineType: "zones/us-central1-a/machineTypes/n2-standard-4", status: "TERMINATED" },
        ],
      },
    },
  });
  const snap = await c.getTopologySnapshot();
  assert.equal(snap.resources.length, 2);
  const web = snap.resources.find((r) => r.name === "web-1");
  assert.equal(web.kind, "cloud_node");
  assert.equal(web.id, "gcp:gce:demo-proj:us-central1-a/web-1");
  assert.equal(web.labels.machineType, "n2-standard-2");
  assert.equal(web.labels.status, "RUNNING");
});

test("Cloud Run services → cloud_service with canonicalName", async () => {
  const c = await makeConnector({
    services: [[{ name: "projects/demo-proj/locations/us-central1/services/checkout" }]],
  });
  const snap = await c.getTopologySnapshot();
  assert.equal(snap.resources.length, 1);
  const svc = snap.resources[0];
  assert.equal(svc.kind, "cloud_service");
  assert.equal(svc.name, "checkout");
  assert.equal(svc.attributes.canonicalName, "checkout");
  assert.equal(svc.labels.runtime, "cloud-run");
});

test("GKE clusters + nodepools produce OWNED_BY edges", async () => {
  const c = await makeConnector({
    clusters: [
      {
        name: "prod-gke",
        location: "us-central1",
        currentMasterVersion: "1.29.4-gke",
        status: "RUNNING",
        nodePools: [
          { name: "default-pool", initialNodeCount: 4, config: { machineType: "n2-standard-2" } },
          { name: "spot-pool", initialNodeCount: 8, config: { machineType: "n2-standard-4" } },
        ],
      },
    ],
  });
  const snap = await c.getTopologySnapshot();
  const cluster = snap.resources.find((r) => r.kind === "cloud_cluster");
  const nodes = snap.resources.filter((r) => r.kind === "cloud_node");
  assert.ok(cluster);
  assert.equal(cluster.labels.version, "1.29.4-gke");
  assert.equal(nodes.length, 2);
  assert.ok(snap.edges.every((e) => e.relation === "OWNED_BY" && e.to === cluster.id));
});

test("listResources + listEdges parity with snapshot", async () => {
  const c = await makeConnector({
    clusters: [{ name: "x", location: "us-central1", nodePools: [{ name: "p", initialNodeCount: 1 }] }],
  });
  const snap = await c.getTopologySnapshot();
  assert.deepEqual(await c.listResources(), snap.resources);
  assert.deepEqual(await c.listEdges(), snap.edges);
});

test("listServices includes cloud_service + cloud_cluster names", async () => {
  const c = await makeConnector({
    services: [[{ name: "projects/p/locations/us-central1/services/checkout" }]],
    clusters: [{ name: "gke-1", location: "us-central1", nodePools: [] }],
  });
  const services = await c.listServices();
  assert.equal(services.length, 2);
  assert.deepEqual(services.map((s) => s.name).sort(), ["checkout", "gke-1"]);
});

test("snapshot cached for TTL", async () => {
  let calls = 0;
  const c = create();
  await c.connect({
    name: "gcp", project: "p",
    _compute: { aggregatedList: async () => { calls++; return {}; }, list: async () => [[]] },
    _run: { listServices: async () => [[]] },
    _container: { listClusters: async () => ({ clusters: [] }) },
  });
  await c.getTopologySnapshot();
  await c.getTopologySnapshot();
  await c.getTopologySnapshot();
  assert.equal(calls, 1);
});

test("malformed Cloud Run service name (no /services/<n>) is skipped", async () => {
  const c = await makeConnector({
    services: [[{ name: "" }, { name: "projects/p/locations/us-central1/services/payment" }]],
  });
  const snap = await c.getTopologySnapshot();
  // Only the well-formed entry survives
  assert.equal(snap.resources.length, 1);
  assert.equal(snap.resources[0].name, "payment");
});
