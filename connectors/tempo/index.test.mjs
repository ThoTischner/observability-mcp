import { test } from "node:test";
import assert from "node:assert/strict";

import create, { TempoConnector } from "./index.js";

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
  assert.ok(c instanceof TempoConnector);
  assert.equal(c.name, "tempo");
  assert.equal(c.signalType, "metrics");
  assert.equal(c.getDefaultMetrics().length, 1);
  assert.equal(c.getDefaultMetrics()[0].unit, "seconds");
});

test("connect requires url; token optional", async () => {
  await assert.rejects(() => create().connect({}), /url is required/);
  const c = create();
  await c.connect({ url: "http://tempo/" });
  assert.equal(c._base, "http://tempo");
  assert.equal(c._token, "");
});

test("TEMPO_TOKEN env is used when no source token", async () => {
  process.env.TEMPO_TOKEN = "envtok";
  const c = create();
  await c.connect({ url: "http://tempo" });
  assert.equal(c._token, "envtok");
  delete process.env.TEMPO_TOKEN;
});

test("healthCheck up/down on /ready", async () => {
  const c = create();
  await c.connect({ url: "http://tempo" });
  globalThis.fetch = mockFetch([["/ready", () => ok("ready")]]);
  assert.equal((await c.healthCheck()).status, "up");
  globalThis.fetch = mockFetch([["/ready", () => ({ ok: false, status: 503, json: async () => ({}) })]]);
  const d = await c.healthCheck();
  assert.equal(d.status, "down");
  assert.match(d.message, /503/);
});

test("listServices reads v2 tag values, tolerates string or object form, never throws", async () => {
  const c = create();
  await c.connect({ url: "http://tempo" });
  globalThis.fetch = mockFetch([
    ["/api/v2/search/tag/resource.service.name/values", () =>
      ok({ tagValues: [{ type: "string", value: "api" }, "db", { value: "" }] })],
  ]);
  assert.deepEqual((await c.listServices()).map((s) => s.name), ["api", "db"]);
  globalThis.fetch = async () => { throw new Error("down"); };
  assert.deepEqual(await c.listServices(), []);
});

test("queryMetrics maps trace durations → seconds, sorted by start time", async () => {
  const c = create();
  await c.connect({ url: "http://tempo" });
  let seen;
  globalThis.fetch = mockFetch([
    ["/api/search", (u) => {
      seen = new URL(u);
      return ok({
        traces: [
          { traceID: "late", startTimeUnixNano: "2000000000000000000", durationMs: 900 },
          { traceID: "early", startTimeUnixNano: "1000000000000000000", durationMs: 100 },
        ],
      });
    }],
  ]);
  const r = await c.queryMetrics({ service: "checkout", metric: "latency_p99", duration: "30m" });
  assert.match(seen.searchParams.get("q"), /resource\.service\.name = "checkout"/);
  assert.ok(/^\d+$/.test(seen.searchParams.get("start")));
  assert.ok(/^\d+$/.test(seen.searchParams.get("limit")));
  // sorted ascending by start time: early (0.1s) before late (0.9s)
  assert.deepEqual(r.values.map((v) => v.value), [0.1, 0.9]);
  assert.equal(r.unit, "seconds");
  assert.equal(r.summary.current, 0.9);
  assert.equal(r.summary.min, 0.1);
});

test("queryMetrics rejects unknown metrics, drops NaN samples", async () => {
  const c = create();
  await c.connect({ url: "http://tempo" });
  await assert.rejects(
    () => c.queryMetrics({ service: "s", metric: "cpu", duration: "1h" }),
    /unknown metric 'cpu'/
  );
  globalThis.fetch = mockFetch([
    ["/api/search", () => ok({ traces: [
      { startTimeUnixNano: "1000000000000000000", durationMs: 200 },
      { startTimeUnixNano: "bad", durationMs: 300 },
      { startTimeUnixNano: "2000000000000000000", durationMs: "x" },
    ] })],
  ]);
  const r = await c.queryMetrics({ service: "s", metric: "latency", duration: "1h" });
  assert.equal(r.values.length, 1);
  assert.equal(r.values[0].value, 0.2);
});
