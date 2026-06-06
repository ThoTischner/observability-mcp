import { test } from "node:test";
import assert from "node:assert/strict";

import create, { LinkerdConnector } from "./index.js";

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
      deployment: src,
      namespace: srcNs,
      dst_deployment: dst,
      dst_namespace: dstNs,
    },
    value: [0, String(value)],
  };
}

test("create() returns LinkerdConnector with signalType topology", () => {
  const c = create();
  assert.ok(c instanceof LinkerdConnector);
  assert.equal(c.signalType, "topology");
});

test("connect requires url", async () => {
  await assert.rejects(create().connect({}), /url is required/);
});

test("healthCheck up / down / throw paths", async () => {
  const ok = create();
  await ok.connect({ name: "linkerd", url: "http://prom:9090", _fetch: fakeProm([]) });
  assert.equal((await ok.healthCheck()).status, "up");

  const down = create();
  await down.connect({
    name: "linkerd",
    url: "http://prom:9090",
    _fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  const h1 = await down.healthCheck();
  assert.equal(h1.status, "down");
  assert.match(h1.message, /HTTP 503/);

  const thrown = create();
  await thrown.connect({
    name: "linkerd",
    url: "http://prom:9090",
    _fetch: async () => { throw new Error("dns failure"); },
  });
  const h2 = await thrown.healthCheck();
  assert.equal(h2.status, "down");
  assert.match(h2.message, /dns/);
});

test("auth token forwarded as Bearer", async () => {
  const c = create();
  await c.connect({
    name: "linkerd",
    url: "http://prom:9090",
    auth: { token: "tok" },
    _fetch: fakeProm([], { token: "tok" }),
  });
  assert.equal((await c.healthCheck()).status, "up");
});

test("empty result → empty snapshot", async () => {
  const c = create();
  await c.connect({ name: "linkerd", url: "http://prom:9090", _fetch: fakeProm([]) });
  const snap = await c.getTopologySnapshot();
  assert.equal(snap.source, "linkerd");
  assert.deepEqual(snap.resources, []);
  assert.deepEqual(snap.edges, []);
});

test("derives service_mesh_service + CALLS with weight-ranked confidence", async () => {
  const c = create();
  await c.connect({
    name: "linkerd",
    url: "http://prom:9090",
    _fetch: fakeProm([
      sample("prod", "checkout", "prod", "payment", 1000),
      sample("prod", "checkout", "prod", "inventory", 100),
    ]),
  });
  const snap = await c.getTopologySnapshot();
  assert.equal(snap.resources.length, 3);
  assert.ok(snap.resources.every((r) => r.kind === "service_mesh_service"));
  assert.equal(snap.edges.length, 2);
  const heavy = snap.edges.find((e) => e.to.endsWith("payment"));
  const light = snap.edges.find((e) => e.to.endsWith("inventory"));
  assert.ok(heavy.confidence > light.confidence);
});

test("self-loops dropped", async () => {
  const c = create();
  await c.connect({
    name: "linkerd",
    url: "http://prom:9090",
    _fetch: fakeProm([sample("prod", "checkout", "prod", "checkout", 50)]),
  });
  const snap = await c.getTopologySnapshot();
  assert.equal(snap.edges.length, 0);
});

test("samples with missing dst dropped", async () => {
  const c = create();
  await c.connect({
    name: "linkerd",
    url: "http://prom:9090",
    _fetch: fakeProm([
      { metric: { deployment: "checkout", namespace: "prod" /* no dst */ }, value: [0, "10"] },
      sample("prod", "checkout", "prod", "payment", 50),
    ]),
  });
  const snap = await c.getTopologySnapshot();
  // Only checkout + payment + one edge survive
  assert.equal(snap.resources.length, 2);
  assert.equal(snap.edges.length, 1);
});

test("duplicate edges aggregate weights", async () => {
  const c = create();
  await c.connect({
    name: "linkerd",
    url: "http://prom:9090",
    _fetch: fakeProm([
      sample("prod", "checkout", "prod", "payment", 100),
      sample("prod", "checkout", "prod", "payment", 200),
    ]),
  });
  const snap = await c.getTopologySnapshot();
  assert.equal(snap.edges.length, 1);
  assert.equal(snap.edges[0].attributes.responses_in_window, 300);
});

test("cross-namespace workloads → distinct ids", async () => {
  const c = create();
  await c.connect({
    name: "linkerd",
    url: "http://prom:9090",
    _fetch: fakeProm([
      sample("prod", "checkout", "prod", "payment", 100),
      sample("staging", "checkout", "staging", "payment", 100),
    ]),
  });
  const snap = await c.getTopologySnapshot();
  const ids = snap.resources.map((r) => r.id).sort();
  assert.deepEqual(ids, [
    "linkerd:service:prod/checkout",
    "linkerd:service:prod/payment",
    "linkerd:service:staging/checkout",
    "linkerd:service:staging/payment",
  ]);
});

test("listResources + listEdges parity with snapshot", async () => {
  const c = create();
  await c.connect({
    name: "linkerd",
    url: "http://prom:9090",
    _fetch: fakeProm([sample("prod", "checkout", "prod", "payment", 50)]),
  });
  const snap = await c.getTopologySnapshot();
  assert.deepEqual(await c.listResources(), snap.resources);
  assert.deepEqual(await c.listEdges(), snap.edges);
});

test("listServices returns discovered service_mesh_service names", async () => {
  const c = create();
  await c.connect({
    name: "linkerd",
    url: "http://prom:9090",
    _fetch: fakeProm([sample("prod", "checkout", "prod", "payment", 50)]),
  });
  const services = await c.listServices();
  assert.equal(services.length, 2);
});

test("snapshot is cached for TTL", async () => {
  let promCalls = 0;
  const c = create();
  await c.connect({
    name: "linkerd",
    url: "http://prom:9090",
    _fetch: async (url) => {
      promCalls += 1;
      const u = url.toString();
      if (u.includes("query=up")) {
        return { ok: true, status: 200, json: async () => ({ status: "success", data: { result: [] } }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: "success", data: { result: [] } }) };
    },
  });
  await c.getTopologySnapshot();
  await c.getTopologySnapshot();
  await c.getTopologySnapshot();
  assert.equal(promCalls, 1);
});
