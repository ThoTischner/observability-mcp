import { test } from "node:test";
import assert from "node:assert/strict";

import create, { ConsulConnector } from "./index.js";

// Fake Consul that routes by path + asserts header presence.
function fakeConsul(routes, opts = {}) {
  const checkToken = opts.token;
  return async (url, init = {}) => {
    if (checkToken) {
      const got = init.headers?.["X-Consul-Token"];
      if (got !== checkToken) throw new Error("missing/wrong token");
    }
    const u = url.toString();
    for (const [match, payload] of routes) {
      if (typeof match === "string" ? u.includes(match) : match(u)) {
        return {
          ok: true,
          status: 200,
          json: async () => (typeof payload === "function" ? payload(u) : payload),
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test("create() returns ConsulConnector with signalType topology", () => {
  const c = create();
  assert.ok(c instanceof ConsulConnector);
  assert.equal(c.signalType, "topology");
});

test("connect requires url", async () => {
  await assert.rejects(create().connect({}), /url is required/);
});

test("healthCheck up via /v1/status/leader 200", async () => {
  const c = create();
  await c.connect({
    name: "consul",
    url: "http://consul:8500",
    _fetch: fakeConsul([["/v1/status/leader", "\"10.0.0.1:8300\""]]),
  });
  assert.equal((await c.healthCheck()).status, "up");
});

test("healthCheck down on 500", async () => {
  const c = create();
  await c.connect({
    name: "consul",
    url: "http://consul:8500",
    _fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  const h = await c.healthCheck();
  assert.equal(h.status, "down");
  assert.match(h.message, /HTTP 500/);
});

test("healthCheck down when fetch throws", async () => {
  const c = create();
  await c.connect({
    name: "consul",
    url: "http://consul:8500",
    _fetch: async () => { throw new Error("connection refused"); },
  });
  const h = await c.healthCheck();
  assert.equal(h.status, "down");
  assert.match(h.message, /refused/);
});

test("token forwarded as X-Consul-Token", async () => {
  const c = create();
  await c.connect({
    name: "consul",
    url: "http://consul:8500",
    auth: { token: "t0k" },
    _fetch: fakeConsul([["/v1/status/leader", "\"leader\""]], { token: "t0k" }),
  });
  assert.equal((await c.healthCheck()).status, "up");
});

test("empty catalog → empty snapshot", async () => {
  const c = create();
  await c.connect({
    name: "consul",
    url: "http://consul:8500",
    _fetch: fakeConsul([["/v1/catalog/services", {}]]),
  });
  const snap = await c.getTopologySnapshot();
  assert.deepEqual(snap.resources, []);
  assert.deepEqual(snap.edges, []);
});

test("catalog services become service_mesh_service resources; consul itself dropped", async () => {
  const c = create();
  await c.connect({
    name: "consul",
    url: "http://consul:8500",
    _fetch: fakeConsul([
      ["/v1/catalog/services", { consul: [], checkout: [], payment: [] }],
      ["/v1/health/service/checkout", [{}, {}, {}]],
      ["/v1/health/service/payment", [{}]],
      ["/v1/connect/intentions/match", {}],
    ]),
  });
  const snap = await c.getTopologySnapshot();
  const names = snap.resources.map((r) => r.name).sort();
  assert.deepEqual(names, ["checkout", "payment"]);
  const checkout = snap.resources.find((r) => r.name === "checkout");
  assert.equal(checkout.labels.instances, "3");
  assert.equal(checkout.attributes.canonicalName, "checkout");
});

test("intentions translate to CALLS edges; allow → confidence 1.0", async () => {
  const c = create();
  await c.connect({
    name: "consul",
    url: "http://consul:8500",
    _fetch: fakeConsul([
      ["/v1/catalog/services", { checkout: [], payment: [], inventory: [] }],
      ["/v1/health/service/", []],
      ["/v1/connect/intentions/match", (u) => {
        if (u.includes("name=payment")) return { payment: [{ SourceName: "checkout", Action: "allow", ID: "i1" }] };
        if (u.includes("name=inventory")) return { inventory: [{ SourceName: "checkout", Action: "deny", ID: "i2" }] };
        return {};
      }],
    ]),
  });
  const snap = await c.getTopologySnapshot();
  const allowEdge = snap.edges.find((e) => e.to.endsWith("payment"));
  const denyEdge = snap.edges.find((e) => e.to.endsWith("inventory"));
  assert.equal(allowEdge.confidence, 1.0);
  assert.equal(denyEdge.confidence, 0.5);
  assert.equal(allowEdge.relation, "CALLS");
});

test("wildcard '*' source is dropped (not a real service)", async () => {
  const c = create();
  await c.connect({
    name: "consul",
    url: "http://consul:8500",
    _fetch: fakeConsul([
      ["/v1/catalog/services", { payment: [] }],
      ["/v1/health/service/", []],
      ["/v1/connect/intentions/match", (u) => {
        if (u.includes("name=payment")) return { payment: [{ SourceName: "*", Action: "allow", ID: "wild" }] };
        return {};
      }],
    ]),
  });
  const snap = await c.getTopologySnapshot();
  assert.equal(snap.edges.length, 0);
});

test("self-intention dropped", async () => {
  const c = create();
  await c.connect({
    name: "consul",
    url: "http://consul:8500",
    _fetch: fakeConsul([
      ["/v1/catalog/services", { checkout: [] }],
      ["/v1/health/service/", []],
      ["/v1/connect/intentions/match", (u) => {
        if (u.includes("name=checkout")) return { checkout: [{ SourceName: "checkout", Action: "allow", ID: "s" }] };
        return {};
      }],
    ]),
  });
  const snap = await c.getTopologySnapshot();
  assert.equal(snap.edges.length, 0);
});

test("intention-only source surfaces as a resource", async () => {
  const c = create();
  await c.connect({
    name: "consul",
    url: "http://consul:8500",
    _fetch: fakeConsul([
      ["/v1/catalog/services", { payment: [] }],
      ["/v1/health/service/", []],
      ["/v1/connect/intentions/match", (u) => {
        if (u.includes("name=payment")) return { payment: [{ SourceName: "external-bot", Action: "allow", ID: "b" }] };
        return {};
      }],
    ]),
  });
  const snap = await c.getTopologySnapshot();
  const names = snap.resources.map((r) => r.name).sort();
  assert.deepEqual(names, ["external-bot", "payment"]);
});

test("datacenter scopes ids", async () => {
  const c = create();
  await c.connect({
    name: "consul",
    url: "http://consul:8500",
    datacenter: "dc-east",
    _fetch: fakeConsul([
      ["/v1/catalog/services", { checkout: [] }],
      ["/v1/health/service/", []],
      ["/v1/connect/intentions/match", {}],
    ]),
  });
  const snap = await c.getTopologySnapshot();
  assert.equal(snap.resources[0].id, "consul:service:dc-east/checkout");
  assert.equal(snap.resources[0].labels.datacenter, "dc-east");
});

test("listResources + listEdges parity with snapshot", async () => {
  const c = create();
  await c.connect({
    name: "consul",
    url: "http://consul:8500",
    _fetch: fakeConsul([
      ["/v1/catalog/services", { checkout: [], payment: [] }],
      ["/v1/health/service/", []],
      ["/v1/connect/intentions/match", (u) => {
        if (u.includes("name=payment")) return { payment: [{ SourceName: "checkout", Action: "allow", ID: "i" }] };
        return {};
      }],
    ]),
  });
  const snap = await c.getTopologySnapshot();
  assert.deepEqual(await c.listResources(), snap.resources);
  assert.deepEqual(await c.listEdges(), snap.edges);
});

test("snapshot cached for TTL", async () => {
  let catalogCalls = 0;
  const c = create();
  await c.connect({
    name: "consul",
    url: "http://consul:8500",
    _fetch: async (url) => {
      const u = url.toString();
      if (u.includes("catalog/services")) catalogCalls += 1;
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  await c.getTopologySnapshot();
  await c.getTopologySnapshot();
  await c.getTopologySnapshot();
  assert.equal(catalogCalls, 1);
});
