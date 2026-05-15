import { test } from "node:test";
import assert from "node:assert/strict";

import create, { DatadogConnector } from "./index.js";

function mockFetch(routes) {
  return async (url, opts) => {
    const u = typeof url === "string" ? url : url.toString();
    for (const [pat, handler] of routes) {
      if (u.includes(pat)) return handler(u, opts);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

test("create() returns a DatadogConnector with the right shape", () => {
  const c = create();
  assert.ok(c instanceof DatadogConnector);
  assert.equal(c.name, "datadog");
  assert.equal(c.signalType, "metrics");
  assert.equal(c.getDefaultMetrics().length, 4);
});

test("connect requires an API key", async () => {
  const c = create();
  await assert.rejects(() => c.connect({ url: "https://api.datadoghq.eu", auth: {} }), /API key missing/);
  delete process.env.DD_API_KEY;
});

test("connect honors config.url and basic-auth key mapping", async () => {
  const c = create();
  await c.connect({ url: "https://api.datadoghq.eu/", auth: { username: "API", password: "APP" } });
  assert.equal(c._base, "https://api.datadoghq.eu");
  assert.equal(c._apiKey, "API");
  assert.equal(c._appKey, "APP");
});

test("healthCheck up / down", async () => {
  const c = create();
  await c.connect({ auth: { username: "k" } });
  globalThis.fetch = mockFetch([["/api/v1/validate", () => ok({ valid: true })]]);
  assert.equal((await c.healthCheck()).status, "up");
  globalThis.fetch = mockFetch([["/api/v1/validate", () => ({ ok: true, status: 200, json: async () => ({ valid: false }) })]]);
  assert.equal((await c.healthCheck()).status, "down");
  globalThis.fetch = mockFetch([["/api/v1/validate", () => ({ ok: false, status: 403, json: async () => ({}) })]]);
  assert.equal((await c.healthCheck()).status, "down");
});

test("queryMetrics maps pointlist, substitutes $service, summarizes", async () => {
  const c = create();
  await c.connect({ auth: { username: "k", password: "a" } });
  let seenQuery = "";
  globalThis.fetch = mockFetch([
    ["/api/v1/query", (u) => {
      seenQuery = new URL(u).searchParams.get("query");
      return ok({ series: [{ pointlist: [[1000, 10], [2000, null], [3000, 30]] }] });
    }],
  ]);
  const r = await c.queryMetrics({ service: "checkout", metric: "cpu", duration: "1h" });
  assert.match(seenQuery, /service:checkout/);
  assert.equal(r.values.length, 2); // null point filtered
  assert.equal(r.unit, "percent");
  assert.equal(r.summary.current, 30);
  assert.equal(r.values[0].timestamp, new Date(1000).toISOString());
});

test("queryMetrics rejects unknown metric and bad duration", async () => {
  const c = create();
  await c.connect({ auth: { username: "k" } });
  await assert.rejects(() => c.queryMetrics({ service: "s", metric: "nope", duration: "1h" }), /unknown metric/);
  await assert.rejects(() => c.queryMetrics({ service: "s", metric: "cpu", duration: "bogus" }), /invalid duration/);
});

test("listServices parses service tags, never throws", async () => {
  const c = create();
  await c.connect({ auth: { username: "k" } });
  globalThis.fetch = mockFetch([
    ["/api/v1/query", () => ok({ series: [{ scope: "service:api,env:prod" }, { scope: "service:db" }] })],
  ]);
  const svcs = await c.listServices();
  assert.deepEqual(svcs.map((s) => s.name).sort(), ["api", "db"]);
  globalThis.fetch = async () => { throw new Error("network down"); };
  assert.deepEqual(await c.listServices(), []);
});

test("queryLogs maps events + counts levels", async () => {
  const c = create();
  await c.connect({ auth: { username: "k", password: "a" } });
  globalThis.fetch = mockFetch([
    ["/api/v2/logs/events/search", () => ok({
      data: [
        { attributes: { timestamp: "2026-05-15T10:00:00Z", status: "error", message: "boom", service: "api" } },
        { attributes: { timestamp: "2026-05-15T10:01:00Z", status: "warn", message: "slow" } },
        { attributes: { timestamp: "2026-05-15T10:02:00Z", status: "info", message: "ok" } },
      ],
    })],
  ]);
  const r = await c.queryLogs({ service: "api", duration: "15m", level: "error" });
  assert.equal(r.entries.length, 3);
  assert.equal(r.summary.errorCount, 1);
  assert.equal(r.summary.warnCount, 1);
  assert.equal(r.entries[0].level, "error");
});
