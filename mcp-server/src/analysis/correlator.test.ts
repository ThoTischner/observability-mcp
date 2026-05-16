import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { correlateSignals, rankRootCause } from "./correlator.js";
import type { AnomalyReport, LogResult, MetricResult } from "../types.js";

describe("correlateSignals", () => {
  it("returns empty for no anomalies", () => {
    const result = correlateSignals([], [], []);
    assert.deepEqual(result, []);
  });

  it("correlates metric anomaly with error logs", () => {
    const anomalies: AnomalyReport[] = [{
      metric: "cpu", severity: "high", description: "cpu spike",
      currentValue: 95, baselineValue: 20, deviationPercent: 375,
      source: "prometheus", service: "api-gateway",
    }];
    const logs: LogResult[] = [{
      source: "loki", service: "api-gateway",
      entries: [],
      summary: { total: 100, errorCount: 30, warnCount: 5, topPatterns: ["NullPointerException (15x)"] },
    }];
    const result = correlateSignals(anomalies, logs, []);
    assert.ok(result.length > 0);
    assert.ok(result[0].includes("api-gateway"));
    assert.ok(result[0].includes("cpu"));
  });

  it("correlates metric cross-signals", () => {
    const anomalies: AnomalyReport[] = [{
      metric: "cpu", severity: "high", description: "cpu spike",
      currentValue: 95, baselineValue: 20, deviationPercent: 375,
      source: "prometheus", service: "payment",
    }];
    const metrics: MetricResult[] = [{
      source: "prometheus", service: "payment", metric: "latency_p99",
      unit: "seconds", values: [], summary: { current: 2.5, average: 0.5, min: 0.3, max: 3.0, trend: "rising" },
    }];
    const result = correlateSignals(anomalies, [], metrics);
    assert.ok(result.some(c => c.includes("latency_p99") && c.includes("rising")));
  });

  it("does not duplicate correlations", () => {
    const anomalies: AnomalyReport[] = [{
      metric: "cpu", severity: "medium", description: "test",
      currentValue: 80, baselineValue: 20, deviationPercent: 300,
      source: "prometheus", service: "svc",
    }];
    const logs: LogResult[] = [{
      source: "loki", service: "svc",
      entries: [],
      summary: { total: 10, errorCount: 5, warnCount: 0, topPatterns: ["err"] },
    }];
    const result = correlateSignals(anomalies, logs, []);
    const unique = new Set(result);
    assert.equal(result.length, unique.size);
  });
});

describe("rankRootCause", () => {
  const A = (service: string, severity: "low" | "medium" | "high" = "high", onsetTs?: number) => ({
    service,
    metric: "latency_p99",
    severity,
    onsetTs,
  });

  it("returns empty result with no anomalies", () => {
    const r = rankRootCause([]);
    assert.deepEqual(r.ranked, []);
  });

  it("single anomalous service is the trivial answer", () => {
    const r = rankRootCause([A("payment-service")]);
    assert.equal(r.ranked.length, 1);
    assert.equal(r.ranked[0].service, "payment-service");
    assert.match(r.summary, /Single anomalous service/);
  });

  it("KEY: the depended-on service outranks its loud downstream caller", () => {
    // api-gateway calls payment-service. Both anomalous, gateway has more
    // signals — but payment-service is the cause; gateway is a victim.
    const anomalies = [
      A("api-gateway", "high"),
      { service: "api-gateway", metric: "error_rate", severity: "high" as const },
      A("payment-service", "medium"),
    ];
    const edges = [{ from: "api-gateway", to: "payment-service" }];
    const r = rankRootCause(anomalies, edges);
    assert.equal(r.ranked[0].service, "payment-service");
    assert.ok(
      r.ranked.find((c) => c.service === "api-gateway")!.score <
        r.ranked[0].score
    );
    assert.match(r.summary, /payment-service/);
  });

  it("transitive dependency: gateway → order → payment ranks payment first", () => {
    const r = rankRootCause(
      [A("api-gateway"), A("order-service"), A("payment-service")],
      [
        { from: "api-gateway", to: "order-service" },
        { from: "order-service", to: "payment-service" },
      ]
    );
    assert.equal(r.ranked[0].service, "payment-service");
  });

  it("onset ordering breaks ties when no graph is available", () => {
    const t = 1_700_000_000_000;
    const r = rankRootCause([
      A("order-service", "high", t + 90_000),
      A("payment-service", "high", t),
    ]);
    assert.equal(r.ranked[0].service, "payment-service");
    assert.ok(r.ranked[0].reasons.some((x) => /started first/.test(x)));
  });

  it("a deploy marker shortly before onset boosts that service", () => {
    const t = 1_700_000_000_000;
    const r = rankRootCause(
      [A("payment-service", "medium", t), A("order-service", "high", t)],
      [],
      [{ service: "payment-service", ts: t - 120_000, kind: "deploy" }]
    );
    assert.equal(r.ranked[0].service, "payment-service");
    assert.ok(r.ranked[0].reasons.some((x) => /deploy/.test(x)));
  });

  it("confidence reflects the score gap", () => {
    const clear = rankRootCause(
      [A("api-gateway"), A("payment-service")],
      [{ from: "api-gateway", to: "payment-service" }]
    );
    assert.equal(clear.ranked[0].confidence, "high");
  });
});
