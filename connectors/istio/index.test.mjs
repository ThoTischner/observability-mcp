import { test } from "node:test";
import assert from "node:assert/strict";

import create, { IstioConnector } from "./index.js";

// Fake Prometheus that returns a canned response by route + asserts
// the auth header is present when one is configured.
function fakeProm(samples, opts = {}) {
  const authCheck = opts.token;
  return async (url, init = {}) => {
    if (authCheck) {
      const got = init.headers?.Authorization;
      if (got !== `Bearer ${authCheck}`) throw new Error("missing or wrong auth");
    }
    const u = url.toString();
    if (u.includes("query=up")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "success", data: { resultType: "vector", result: [] } }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: "success", data: { resultType: "vector", result: samples } }),
    };
  };
}

function sample(srcNs, src, dstNs, dst, value) {
  return {
    metric: {
      source_workload: src,
      source_workload_namespace: srcNs,
      destination_workload: dst,
      destination_workload_namespace: dstNs,
    },
    value: [0, String(value)],
  };
}

test("create() returns IstioConnector with signalType topology", () => {
  const c = create();
  assert.ok(c instanceof IstioConnector);
  assert.equal(c.signalType, "topology");
});

test("connect requires url", async () => {
  const c = create();
  await assert.rejects(c.connect({}), /url is required/);
});

test("healthCheck up when Prometheus responds 200", async () => {
  const c = create();
  await c.connect({ name: "istio", url: "http://prom:9090", _fetch: fakeProm([]) });
  const h = await c.healthCheck();
  assert.equal(h.status, "up");
});

test("healthCheck down when Prometheus 500s", async () => {
  const c = create();
  await c.connect({
    name: "istio",
    url: "http://prom:9090",
    _fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  const h = await c.healthCheck();
  assert.equal(h.status, "down");
  assert.match(h.message, /HTTP 500/);
});

test("healthCheck down when fetch throws", async () => {
  const c = create();
  await c.connect({
    name: "istio",
    url: "http://prom:9090",
    _fetch: async () => { throw new Error("connection refused"); },
  });
  const h = await c.healthCheck();
  assert.equal(h.status, "down");
  assert.match(h.message, /refused/);
});

test("auth token forwarded as Bearer", async () => {
  const c = create();
  await c.connect({
    name: "istio",
    url: "http://prom:9090",
    auth: { token: "t0k3n" },
    _fetch: fakeProm([], { token: "t0k3n" }),
  });
  const h = await c.healthCheck();
  assert.equal(h.status, "up");
});

test("empty Prometheus result → empty snapshot", async () => {
  const c = create();
  await c.connect({ name: "istio", url: "http://prom:9090", _fetch: fakeProm([]) });
  const snap = await c.getTopologySnapshot();
  assert.equal(snap.source, "istio");
  assert.deepEqual(snap.resources, []);
  assert.deepEqual(snap.edges, []);
});

test("derives service_mesh_service resources + CALLS edges from samples", async () => {
  const c = create();
  await c.connect({
    name: "istio",
    url: "http://prom:9090",
    _fetch: fakeProm([
      sample("prod", "checkout", "prod", "payment", 1000),
      sample("prod", "checkout", "prod", "inventory", 100),
    ]),
  });
  const snap = await c.getTopologySnapshot();
  // 3 services: checkout, payment, inventory
  assert.equal(snap.resources.length, 3);
  assert.ok(snap.resources.every((r) => r.kind === "service_mesh_service"));
  assert.ok(snap.resources.every((r) => r.attributes.canonicalName));
  // 2 CALLS edges
  assert.equal(snap.edges.length, 2);
  assert.ok(snap.edges.every((e) => e.relation === "CALLS"));
  // Edge confidence: chatty edge ranks higher
  const heavy = snap.edges.find((e) => e.to.endsWith("payment"));
  const light = snap.edges.find((e) => e.to.endsWith("inventory"));
  assert.ok(heavy.confidence > light.confidence);
});

test("self-loops are dropped", async () => {
  const c = create();
  await c.connect({
    name: "istio",
    url: "http://prom:9090",
    _fetch: fakeProm([sample("prod", "checkout", "prod", "checkout", 50)]),
  });
  const snap = await c.getTopologySnapshot();
  assert.equal(snap.edges.length, 0);
});

test("'unknown' workload entries are dropped", async () => {
  const c = create();
  await c.connect({
    name: "istio",
    url: "http://prom:9090",
    _fetch: fakeProm([
      sample("prod", "unknown", "prod", "checkout", 50),
      sample("prod", "checkout", "prod", "unknown", 50),
      sample("prod", "checkout", "prod", "payment", 50),
    ]),
  });
  const snap = await c.getTopologySnapshot();
  // Only checkout + payment survive; one edge
  assert.equal(snap.resources.length, 2);
  assert.equal(snap.edges.length, 1);
});

test("duplicate edges aggregate into one with summed weight", async () => {
  const c = create();
  await c.connect({
    name: "istio",
    url: "http://prom:9090",
    // Same (src, dst) appearing twice — different label noise upstream
    _fetch: fakeProm([
      sample("prod", "checkout", "prod", "payment", 100),
      sample("prod", "checkout", "prod", "payment", 200),
    ]),
  });
  const snap = await c.getTopologySnapshot();
  assert.equal(snap.edges.length, 1);
  assert.equal(snap.edges[0].attributes.requests_in_window, 300);
});

test("cross-namespace workloads produce distinct ids", async () => {
  const c = create();
  await c.connect({
    name: "istio",
    url: "http://prom:9090",
    _fetch: fakeProm([
      sample("prod", "checkout", "prod", "payment", 100),
      sample("staging", "checkout", "staging", "payment", 100),
    ]),
  });
  const snap = await c.getTopologySnapshot();
  const ids = snap.resources.map((r) => r.id).sort();
  assert.deepEqual(ids, [
    "istio:service:prod/checkout",
    "istio:service:prod/payment",
    "istio:service:staging/checkout",
    "istio:service:staging/payment",
  ]);
});

test("listResources + listEdges parity with snapshot", async () => {
  const c = create();
  await c.connect({
    name: "istio",
    url: "http://prom:9090",
    _fetch: fakeProm([sample("prod", "checkout", "prod", "payment", 100)]),
  });
  const snap = await c.getTopologySnapshot();
  const r = await c.listResources();
  const e = await c.listEdges();
  assert.deepEqual(r, snap.resources);
  assert.deepEqual(e, snap.edges);
});

test("listServices returns discovered service_mesh_service names", async () => {
  const c = create();
  await c.connect({
    name: "istio",
    url: "http://prom:9090",
    _fetch: fakeProm([sample("prod", "checkout", "prod", "payment", 100)]),
  });
  const services = await c.listServices();
  assert.equal(services.length, 2);
  assert.deepEqual(services.map((s) => s.name).sort(), ["checkout", "payment"]);
});
