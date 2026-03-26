import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { correlateSignals } from "./correlator.js";
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
