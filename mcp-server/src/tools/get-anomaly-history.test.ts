import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ConnectorRegistry } from "../connectors/registry.js";
import type { MetricQuery, MetricResult } from "../types.js";
import { getAnomalyHistoryHandler } from "./get-anomaly-history.js";

// Regression guard for the wired-but-dead bug found in the v3.2 audit:
// get_anomaly_history hand-builds a complete PromQL selector
// (`omcp_anomaly_score{service="x",method="mad"}`) and must pass it via
// `rawQuery` (verbatim passthrough), NOT via `metric`. The curated `metric`
// path wraps the value in `{ {{selector}} }`, which for an already-complete
// selector yields invalid double-brace PromQL → Prometheus 400 → the handler
// swallowed it and always returned "no history". This test pins that the
// connector receives a verbatim rawQuery and never the manglable metric path.

function fakeRegistry(capture: (q: MetricQuery) => void, result: MetricResult | null): ConnectorRegistry {
  const conn = {
    name: "prom",
    type: "prometheus",
    signalType: "metrics" as const,
    async queryMetrics(q: MetricQuery): Promise<MetricResult> {
      capture(q);
      if (!result) throw new Error("no data");
      return result;
    },
  };
  return { getByTenant: () => [conn] } as unknown as ConnectorRegistry;
}

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0].text);
}

describe("get_anomaly_history — rawQuery wiring (audit regression)", () => {
  it("routes the omcp_anomaly_score selector via rawQuery, not metric", async () => {
    let captured: MetricQuery | undefined;
    const reg = fakeRegistry(
      (q) => (captured = q),
      {
        source: "prom",
        service: "payment",
        metric: "omcp_anomaly_score",
        unit: "",
        values: [{ timestamp: "2026-06-09T00:00:00.000Z", value: 0.7 }],
        summary: { current: 0.7, average: 0.7, min: 0.7, max: 0.7, trend: "stable" },
      } as MetricResult,
    );

    const out = parse(await getAnomalyHistoryHandler(reg, { service: "payment", method: "mad", duration: "1h" }));

    assert.ok(captured, "connector.queryMetrics must be called");
    // The fix: rawQuery carries the verbatim selector.
    assert.equal(captured!.rawQuery, 'omcp_anomaly_score{service="payment",method="mad"}');
    // And it must NOT be smuggled through the curated `metric` path (which would
    // double-brace it). metric may be a bare name placeholder, but never the selector.
    assert.doesNotMatch(String(captured!.metric ?? ""), /\{/, "metric must not carry the brace selector");
    // Sanity: the verbatim query has exactly one brace block (no double-brace).
    assert.equal((captured!.rawQuery!.match(/\{/g) || []).length, 1);

    assert.equal(out.isError, undefined);
    assert.equal(out.values.length, 1);
  });

  it("omits the method filter when not given", async () => {
    let captured: MetricQuery | undefined;
    const reg = fakeRegistry((q) => (captured = q), {
      source: "prom", service: "api", metric: "omcp_anomaly_score", unit: "",
      values: [{ timestamp: "2026-06-09T00:00:00.000Z", value: 1 }],
      summary: { current: 1, average: 1, min: 1, max: 1, trend: "stable" },
    } as MetricResult);

    await getAnomalyHistoryHandler(reg, { service: "api" });
    assert.equal(captured!.rawQuery, 'omcp_anomaly_score{service="api"}');
  });
});
