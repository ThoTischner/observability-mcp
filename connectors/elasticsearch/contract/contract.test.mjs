import { test } from "node:test";
import assert from "node:assert/strict";

import create from "../index.js";
import { CONTRACT, checkRequest } from "./contract.mjs";

function contractFetch(violations) {
  return async (url, opts = {}) => {
    const u = url.toString();
    const method = (opts.method || "GET").toUpperCase();
    const v = checkRequest(method, u, opts.headers || {}, opts.body);
    if (v) violations.push(v);
    const rule = CONTRACT[`${method} ${new URL(u).pathname}`];
    let resp = {};
    if (rule) {
      const body = opts.body ? JSON.parse(opts.body) : {};
      resp = typeof rule.response === "function" ? rule.response(body) : rule.response;
    }
    return { ok: true, status: 200, json: async () => resp };
  };
}

test("checkRequest has teeth", () => {
  assert.match(checkRequest("GET", "http://e/_cluster/health", {}), /missing required header Authorization/);
  assert.match(checkRequest("GET", "http://e/_cluster/health", { Authorization: "Token x" }), /must be 'ApiKey/);
  assert.match(checkRequest("POST", "http://e/logs-*/_search", { Authorization: "ApiKey k", "Content-Type": "application/json" }, "{}"), /body.query .* required/);
  assert.match(checkRequest("GET", "http://e/_nope", { Authorization: "ApiKey k" }), /unexpected request/);
  assert.equal(checkRequest("GET", "http://e/_cluster/health", { Authorization: "ApiKey k" }), null);
});

test("connector honours the Elasticsearch contract end-to-end", async () => {
  const violations = [];
  globalThis.fetch = contractFetch(violations);
  const c = create();
  await c.connect({ url: "http://es.local:9200", auth: { token: "the-api-key" } });

  assert.equal((await c.healthCheck()).status, "up");

  const m = await c.queryMetrics({ service: "checkout", metric: "log_rate", duration: "1h" });
  assert.equal(m.values.length, 2);
  assert.equal(m.unit, "doc/s");

  const s = await c.listServices();
  assert.deepEqual(s.map((x) => x.name), ["checkout", "payments"]);

  const l = await c.queryLogs({ service: "checkout", duration: "15m" });
  assert.equal(l.entries.length, 2);
  assert.equal(l.summary.errorCount, 1);
  assert.equal(l.entries[0].level, "error");

  assert.deepEqual(violations, [], `contract violations:\n${violations.join("\n")}`);
});
