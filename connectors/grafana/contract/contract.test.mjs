import { test } from "node:test";
import assert from "node:assert/strict";

import create from "../index.js";
import { CONTRACT, checkRequest } from "./contract.mjs";

function contractFetch(violations) {
  return async (url, opts = {}) => {
    const u = url.toString();
    const method = (opts.method || "GET").toUpperCase();
    const v = checkRequest(method, u, opts.headers || {});
    if (v) violations.push(v);
    const rule = CONTRACT[`${method} ${new URL(u).pathname}`];
    return { ok: true, status: 200, json: async () => (rule ? rule.response : {}) };
  };
}

test("checkRequest has teeth", () => {
  assert.match(checkRequest("GET", "http://g/api/health", {}), /missing required header Authorization/);
  assert.match(checkRequest("GET", "http://g/api/health", { Authorization: "Basic x" }), /must be 'Bearer/);
  assert.match(
    checkRequest("GET", "http://g/api/datasources/proxy/uid/prom-uid/api/v1/query_range?start=1&end=2&step=3", { Authorization: "Bearer t" }),
    /missing required query param 'query'/
  );
  assert.match(checkRequest("GET", "http://g/api/v9/nope", { Authorization: "Bearer t" }), /unexpected request/);
  assert.equal(checkRequest("GET", "http://g/api/health", { Authorization: "Bearer t" }), null);
});

test("connector honours the Grafana request contract end-to-end", async () => {
  const violations = [];
  globalThis.fetch = contractFetch(violations);
  const c = create();
  await c.connect({ url: "http://grafana.local", auth: { token: "svc-token" } });
  assert.equal(c._promUid, "prom-uid");
  assert.equal(c._lokiUid, "loki-uid");

  const h = await c.healthCheck();
  assert.equal(h.status, "up");

  const m = await c.queryMetrics({ service: "checkout", metric: "cpu", duration: "1h" });
  assert.equal(m.values.length, 2);
  assert.equal(m.summary.current, 18.2);

  const s = await c.listServices();
  assert.deepEqual(s.map((x) => x.name), ["checkout", "payments"]);

  const l = await c.queryLogs({ service: "checkout", duration: "15m" });
  assert.equal(l.entries.length, 2);
  assert.equal(l.summary.errorCount, 1);

  assert.deepEqual(violations, [], `contract violations:\n${violations.join("\n")}`);
});
