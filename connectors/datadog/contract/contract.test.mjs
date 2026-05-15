import { test } from "node:test";
import assert from "node:assert/strict";

import create from "../index.js";
import { CONTRACT, checkRequest } from "./contract.mjs";

// A capturing fetch: validates every outgoing request against the
// contract (independent of connector code) and replies with the
// contract's example response so we also exercise response parsing.
function contractFetch(violations) {
  return async (url, opts = {}) => {
    const u = url.toString();
    const method = (opts.method || "GET").toUpperCase();
    const v = checkRequest(method, u, opts.headers || {}, opts.body);
    if (v) violations.push(v);
    const key = `${method} ${new URL(u).pathname}`;
    const rule = CONTRACT[key];
    return {
      ok: true,
      status: 200,
      json: async () => (rule ? rule.response : {}),
    };
  };
}

test("checkRequest has teeth (rejects malformed requests)", () => {
  assert.match(checkRequest("GET", "http://x/api/v1/query?to=1&query=q", {}, null), /missing required header/);
  assert.match(checkRequest("GET", "http://x/api/v1/query?from=1&to=2", { "DD-API-KEY": "k" }, null), /missing required query param 'query'/);
  assert.match(checkRequest("GET", "http://x/api/v1/query?from=ab&to=2&query=q", { "DD-API-KEY": "k" }, null), /not an integer/);
  assert.match(checkRequest("POST", "http://x/api/v2/logs/events/search", { "DD-API-KEY": "k" }, "{}"), /missing required key 'filter'/);
  assert.match(checkRequest("GET", "http://x/api/v9/nope", { "DD-API-KEY": "k" }, null), /unexpected request/);
  assert.equal(checkRequest("GET", "http://x/api/v1/validate", { "DD-API-KEY": "k" }, null), null);
});

test("connector honours the Datadog request contract end-to-end", async () => {
  const violations = [];
  globalThis.fetch = contractFetch(violations);
  const c = create();
  await c.connect({ url: "http://dd.local", auth: { username: "API", password: "APP" } });

  const h = await c.healthCheck();
  assert.equal(h.status, "up");

  const m = await c.queryMetrics({ service: "checkout", metric: "cpu", duration: "1h" });
  assert.equal(m.values.length, 2, "null point dropped");
  assert.equal(m.summary.current, 18.2);
  assert.equal(m.values[0].timestamp, new Date(1715760000000).toISOString());

  const s = await c.listServices();
  assert.deepEqual(s.map((x) => x.name), ["checkout"]);

  const l = await c.queryLogs({ service: "checkout", duration: "15m", level: "error" });
  assert.equal(l.entries.length, 3);
  assert.equal(l.summary.errorCount, 1);
  assert.equal(l.summary.warnCount, 1);

  assert.deepEqual(violations, [], `contract violations:\n${violations.join("\n")}`);
});
