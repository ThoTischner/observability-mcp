import { test } from "node:test";
import assert from "node:assert/strict";

import create, { GrafanaConnector } from "./index.js";

function mockFetch(routes) {
  return async (url) => {
    const u = url.toString();
    for (const [pat, h] of routes) if (u.includes(pat)) return h(u);
    return { ok: false, status: 404, json: async () => ({}) };
  };
}
const ok = (b) => ({ ok: true, status: 200, json: async () => b });

test("create() shape", () => {
  const c = create();
  assert.ok(c instanceof GrafanaConnector);
  assert.equal(c.name, "grafana");
  assert.equal(c.getDefaultMetrics().length, 4);
});

test("connect requires url + token, auto-resolves datasource uids", async () => {
  await assert.rejects(() => create().connect({ auth: { token: "t" } }), /url is required/);
  await assert.rejects(() => create().connect({ url: "http://g" }), /token missing/);
  const c = create();
  globalThis.fetch = mockFetch([
    ["/api/datasources", () => ok([
      { type: "prometheus", uid: "prom-1" },
      { type: "loki", uid: "loki-1" },
      { type: "prometheus", uid: "prom-2" },
    ])],
  ]);
  await c.connect({ url: "http://g/", auth: { token: "t" } });
  assert.equal(c._base, "http://g");
  assert.equal(c._promUid, "prom-1");
  assert.equal(c._lokiUid, "loki-1");
});

test("env uids override auto-resolution", async () => {
  process.env.GRAFANA_PROM_DS_UID = "envprom";
  process.env.GRAFANA_LOKI_DS_UID = "envloki";
  const c = create();
  globalThis.fetch = mockFetch([["/api/datasources", () => ok([{ type: "prometheus", uid: "x" }])]]);
  await c.connect({ url: "http://g", auth: { token: "t" } });
  assert.equal(c._promUid, "envprom");
  assert.equal(c._lokiUid, "envloki");
  delete process.env.GRAFANA_PROM_DS_UID;
  delete process.env.GRAFANA_LOKI_DS_UID;
});

test("healthCheck up/down", async () => {
  const c = create();
  globalThis.fetch = mockFetch([["/api/datasources", () => ok([])]]);
  await c.connect({ url: "http://g", auth: { token: "t" } });
  globalThis.fetch = mockFetch([["/api/health", () => ok({ database: "ok" })]]);
  assert.equal((await c.healthCheck()).status, "up");
  globalThis.fetch = mockFetch([["/api/health", () => ({ ok: false, status: 502, json: async () => ({}) })]]);
  assert.equal((await c.healthCheck()).status, "down");
});

test("queryMetrics proxies query_range, maps matrix, substitutes $service", async () => {
  process.env.GRAFANA_PROM_DS_UID = "p1";
  const c = create();
  globalThis.fetch = mockFetch([["/api/datasources", () => ok([])]]);
  await c.connect({ url: "http://g", auth: { token: "t" } });
  let seen;
  globalThis.fetch = mockFetch([
    ["/api/datasources/proxy/uid/p1/api/v1/query_range", (u) => {
      seen = new URL(u);
      return ok({ data: { result: [{ values: [[1715760000, "1.5"], [1715760060, "2.5"]] }] } });
    }],
  ]);
  const r = await c.queryMetrics({ service: "checkout", metric: "cpu", duration: "1h" });
  assert.match(seen.searchParams.get("query"), /service="checkout"/);
  assert.ok(seen.searchParams.get("start") && seen.searchParams.get("step"));
  assert.equal(r.values.length, 2);
  assert.equal(r.unit, "percent");
  assert.equal(r.summary.current, 2.5);
  delete process.env.GRAFANA_PROM_DS_UID;
});

test("queryMetrics errors without a prom uid + on unknown metric", async () => {
  const c = create();
  globalThis.fetch = mockFetch([["/api/datasources", () => ok([])]]);
  await c.connect({ url: "http://g", auth: { token: "t" } });
  await assert.rejects(() => c.queryMetrics({ service: "s", metric: "cpu", duration: "1h" }), /no Prometheus datasource/);
  process.env.GRAFANA_PROM_DS_UID = "p1";
  const c2 = create();
  globalThis.fetch = mockFetch([["/api/datasources", () => ok([])]]);
  await c2.connect({ url: "http://g", auth: { token: "t" } });
  await assert.rejects(() => c2.queryMetrics({ service: "s", metric: "nope", duration: "1h" }), /unknown metric/);
  delete process.env.GRAFANA_PROM_DS_UID;
});

test("listServices reads prom label values, never throws", async () => {
  process.env.GRAFANA_PROM_DS_UID = "p1";
  const c = create();
  globalThis.fetch = mockFetch([["/api/datasources", () => ok([])]]);
  await c.connect({ url: "http://g", auth: { token: "t" } });
  globalThis.fetch = mockFetch([
    ["/api/datasources/proxy/uid/p1/api/v1/label/service/values", () => ok({ data: ["api", "db"] })],
  ]);
  assert.deepEqual((await c.listServices()).map((s) => s.name), ["api", "db"]);
  globalThis.fetch = async () => { throw new Error("down"); };
  assert.deepEqual(await c.listServices(), []);
  delete process.env.GRAFANA_PROM_DS_UID;
});

test("queryLogs proxies Loki, counts levels", async () => {
  process.env.GRAFANA_LOKI_DS_UID = "l1";
  const c = create();
  globalThis.fetch = mockFetch([["/api/datasources", () => ok([])]]);
  await c.connect({ url: "http://g", auth: { token: "t" } });
  globalThis.fetch = mockFetch([
    ["/api/datasources/proxy/uid/l1/loki/api/v1/query_range", () => ok({
      data: { result: [
        { stream: { service: "api", level: "error" }, values: [["1715760000000000000", "boom"]] },
        { stream: { service: "api", level: "info" }, values: [["1715760060000000000", "ok"]] },
      ] },
    })],
  ]);
  const r = await c.queryLogs({ service: "api", duration: "15m" });
  assert.equal(r.entries.length, 2);
  assert.equal(r.summary.errorCount, 1);
  assert.equal(r.entries[0].level, "error");
  delete process.env.GRAFANA_LOKI_DS_UID;
});
