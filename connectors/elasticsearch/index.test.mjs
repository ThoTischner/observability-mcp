import { test } from "node:test";
import assert from "node:assert/strict";

import create, { ElasticsearchConnector } from "./index.js";

function mockFetch(routes) {
  return async (url, opts) => {
    const u = url.toString();
    for (const [pat, h] of routes) if (u.includes(pat)) return h(u, opts);
    return { ok: false, status: 404, json: async () => ({}) };
  };
}
const ok = (b) => ({ ok: true, status: 200, json: async () => b });

test("create() shape", () => {
  const c = create();
  assert.ok(c instanceof ElasticsearchConnector);
  assert.equal(c.name, "elasticsearch");
  assert.equal(c.getDefaultMetrics().length, 2);
});

test("connect requires url; api-key vs basic auth", async () => {
  await assert.rejects(() => create().connect({ auth: { token: "k" } }), /url is required/);
  const k = create();
  await k.connect({ url: "http://es:9200/", auth: { token: "abc" } });
  assert.equal(k._base, "http://es:9200");
  assert.equal(k._authHeader, "ApiKey abc");
  const b = create();
  await b.connect({ url: "http://es:9200", auth: { username: "u", password: "p" } });
  assert.equal(b._authHeader, "Basic " + Buffer.from("u:p").toString("base64"));
});

test("healthCheck maps cluster status", async () => {
  const c = create();
  await c.connect({ url: "http://es:9200", auth: { token: "k" } });
  globalThis.fetch = mockFetch([["/_cluster/health", () => ok({ status: "green" })]]);
  assert.equal((await c.healthCheck()).status, "up");
  globalThis.fetch = mockFetch([["/_cluster/health", () => ok({ status: "yellow" })]]);
  assert.equal((await c.healthCheck()).status, "up");
  globalThis.fetch = mockFetch([["/_cluster/health", () => ok({ status: "red" })]]);
  assert.equal((await c.healthCheck()).status, "down");
  globalThis.fetch = mockFetch([["/_cluster/health", () => ({ ok: false, status: 401, json: async () => ({}) })]]);
  assert.equal((await c.healthCheck()).status, "down");
});

test("listServices reads terms agg, never throws", async () => {
  const c = create();
  await c.connect({ url: "http://es:9200", auth: { token: "k" } });
  globalThis.fetch = mockFetch([
    ["/_search", () => ok({ aggregations: { svc: { buckets: [{ key: "api" }, { key: "db" }] } } })],
  ]);
  assert.deepEqual((await c.listServices()).map((s) => s.name), ["api", "db"]);
  globalThis.fetch = async () => { throw new Error("down"); };
  assert.deepEqual(await c.listServices(), []);
});

test("queryMetrics builds date_histogram, normalizes by interval", async () => {
  const c = create();
  await c.connect({ url: "http://es:9200", auth: { token: "k" } });
  let body;
  globalThis.fetch = mockFetch([
    ["/_search", (_u, o) => {
      body = JSON.parse(o.body);
      return ok({ aggregations: { ts: { buckets: [
        { key: 1715760000000, doc_count: 30 },
        { key: 1715760060000, doc_count: 0 },
      ] } } });
    }],
  ]);
  const r = await c.queryMetrics({ service: "checkout", metric: "error_rate", duration: "1h" });
  // service filter + error query_string present
  const fstr = JSON.stringify(body.query.bool.filter);
  assert.match(fstr, /"service.name":"checkout"/);
  assert.match(fstr, /log.level:error/);
  assert.ok(body.aggs.ts.date_histogram.fixed_interval);
  assert.equal(r.unit, "doc/s");
  assert.equal(r.values.length, 2);
  assert.ok(r.values[0].value > 0);
});

test("queryMetrics rejects unknown metric + bad duration", async () => {
  const c = create();
  await c.connect({ url: "http://es:9200", auth: { token: "k" } });
  await assert.rejects(() => c.queryMetrics({ service: "s", metric: "nope", duration: "1h" }), /unknown metric/);
  await assert.rejects(() => c.queryMetrics({ service: "s", metric: "log_rate", duration: "x" }), /invalid duration/);
});

test("queryLogs maps hits + counts levels", async () => {
  const c = create();
  await c.connect({ url: "http://es:9200", auth: { token: "k" } });
  globalThis.fetch = mockFetch([
    ["/_search", () => ok({ hits: { hits: [
      { _source: { "@timestamp": "2026-05-16T10:00:00Z", log: { level: "error" }, message: "boom", service: { name: "api" } } },
      { _source: { "@timestamp": "2026-05-16T10:01:00Z", log: { level: "warn" }, message: "slow" } },
      { _source: { "@timestamp": "2026-05-16T10:02:00Z", message: "ok" } },
    ] } })],
  ]);
  const r = await c.queryLogs({ service: "api", duration: "15m", level: "error" });
  assert.equal(r.entries.length, 3);
  assert.equal(r.summary.errorCount, 1);
  assert.equal(r.summary.warnCount, 1);
  assert.equal(r.entries[0].level, "error");
  assert.equal(r.entries[0].labels.service, "api");
});
