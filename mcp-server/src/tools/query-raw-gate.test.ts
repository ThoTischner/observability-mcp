import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConnectorRegistry } from "../connectors/registry.js";
import { PluginLoader } from "../connectors/loader.js";
import { queryMetricsHandler } from "./query-metrics.js";
import { queryLogsHandler } from "./query-logs.js";

// R4 (issue #415 #3): raw_query is an escape hatch that bypasses the curated
// metric/log surface, so it MUST be refused unless the operator enabled the
// capability (opts.allowRawQuery, driven by OMCP_RAW_QUERY). These tests pin
// the gate: the denial fires before any backend is touched, so an empty
// registry is enough — and with the capability ON the call proceeds past the
// gate to the normal "no backend configured" path.

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("raw_query capability gate", () => {
  const emptyRegistry = () => new ConnectorRegistry(new PluginLoader());

  it("query_metrics refuses raw_query when capability is off (default)", async () => {
    const out = parse(
      await queryMetricsHandler(emptyRegistry(), { raw_query: "up" }, undefined, { allowRawQuery: false }),
    );
    assert.match(out.error, /raw_query is disabled/i);
    assert.match(out.error, /OMCP_RAW_QUERY/);
  });

  it("query_metrics defaults to refusing raw_query when no opts passed", async () => {
    const out = parse(await queryMetricsHandler(emptyRegistry(), { raw_query: "up" }));
    assert.match(out.error, /raw_query is disabled/i);
  });

  it("query_logs refuses raw_query when capability is off (default)", async () => {
    const out = parse(
      await queryLogsHandler(emptyRegistry(), { raw_query: '{job="x"}' }, undefined, { allowRawQuery: false }),
    );
    assert.match(out.error, /raw_query is disabled/i);
  });

  it("query_metrics passes the gate when capability is on (reaches backend resolution)", async () => {
    const out = parse(
      await queryMetricsHandler(emptyRegistry(), { raw_query: "up" }, undefined, { allowRawQuery: true }),
    );
    // Past the gate → normal no-backend path, NOT the capability denial.
    assert.doesNotMatch(out.error ?? "", /raw_query is disabled/i);
    assert.match(out.error, /No metrics backends configured/i);
  });

  it("query_logs passes the gate when capability is on (reaches backend resolution)", async () => {
    const out = parse(
      await queryLogsHandler(emptyRegistry(), { raw_query: '{job="x"}' }, undefined, { allowRawQuery: true }),
    );
    assert.doesNotMatch(out.error ?? "", /raw_query is disabled/i);
    assert.match(out.error, /No log backends configured/i);
  });

  it("query_logs rejects raw_query + aggregate as mutually exclusive", async () => {
    const out = parse(
      await queryLogsHandler(
        emptyRegistry(),
        { raw_query: '{job="x"}', aggregate: { op: "count_over_time" } },
        undefined,
        { allowRawQuery: true },
      ),
    );
    assert.match(out.error, /mutually exclusive/i);
  });

  it("normal (non-raw) calls are unaffected by the capability flag", async () => {
    // No raw_query → gate is a no-op even with capability off; falls through
    // to normal validation/backend path.
    const out = parse(
      await queryMetricsHandler(emptyRegistry(), { service: "api", metric: "cpu" }, undefined, { allowRawQuery: false }),
    );
    assert.doesNotMatch(out.error ?? "", /raw_query/i);
  });
});
