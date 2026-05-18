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
  assert.equal(checkRequest("GET", "http://t/ready", {}), null);
  assert.match(
    checkRequest("GET", "http://t/api/search?start=1&end=2&limit=3", {}),
    /missing required query param 'q'/
  );
  assert.match(
    checkRequest("GET", "http://t/api/search?q=%7B%7D&start=x&end=2&limit=3", {}),
    /query 'start'='x' is not an integer/
  );
  assert.match(checkRequest("GET", "http://t/api/v9/nope", {}), /unexpected request/);
  assert.equal(
    checkRequest("GET", "http://t/api/search?q=%7B%7D&start=1&end=2&limit=3", {}),
    null
  );
});

test("connector honours the Tempo request contract end-to-end", async () => {
  const violations = [];
  globalThis.fetch = contractFetch(violations);
  const c = create();
  await c.connect({ url: "http://tempo.local/", auth: { token: "svc-token" } });

  const h = await c.healthCheck();
  assert.equal(h.status, "up");

  const s = await c.listServices();
  assert.deepEqual(s.map((x) => x.name), ["checkout", "payments"]);
  assert.equal(s[0].signalType, "metrics");

  const m = await c.queryMetrics({ service: "checkout", metric: "latency", duration: "1h" });
  assert.equal(m.unit, "seconds");
  assert.equal(m.values.length, 2);
  // 120ms / 480ms → 0.12s / 0.48s, ordered by trace start time.
  assert.deepEqual(m.values.map((v) => v.value), [0.12, 0.48]);
  assert.equal(m.summary.current, 0.48);
  assert.equal(m.summary.min, 0.12);
  assert.match(m.resolvedSeries, /resource\.service\.name = "checkout"/);

  assert.deepEqual(violations, [], `contract violations:\n${violations.join("\n")}`);
});
