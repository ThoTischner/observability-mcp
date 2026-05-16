import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateZScore,
  detectAnomalyPoints,
  detectRecentAnomaly,
  detectRobustAnomaly,
  classifyMetric,
  median,
  mad,
} from "./anomaly.js";

describe("calculateZScore", () => {
  it("returns zeros for empty array", () => {
    const result = calculateZScore([]);
    assert.equal(result.mean, 0);
    assert.equal(result.stdDev, 0);
    assert.deepEqual(result.zScores, []);
  });

  it("calculates correct mean and stdDev", () => {
    const result = calculateZScore([2, 4, 4, 4, 5, 5, 7, 9]);
    assert.ok(Math.abs(result.mean - 5) < 0.001);
    assert.ok(result.stdDev > 0);
  });

  it("returns zero z-scores for constant values", () => {
    const result = calculateZScore([5, 5, 5, 5]);
    assert.equal(result.mean, 5);
    assert.equal(result.stdDev, 0);
    assert.deepEqual(result.zScores, [0, 0, 0, 0]);
  });

  it("outlier has high z-score", () => {
    const values = [10, 10, 10, 10, 10, 10, 10, 10, 10, 100];
    const result = calculateZScore(values);
    const lastZ = result.zScores[result.zScores.length - 1];
    assert.ok(lastZ > 2, `Expected z-score > 2, got ${lastZ}`);
  });
});

describe("detectAnomalyPoints", () => {
  it("returns empty for constant values", () => {
    assert.deepEqual(detectAnomalyPoints([5, 5, 5, 5]), []);
  });

  it("detects outlier with default threshold", () => {
    const values = [10, 10, 10, 10, 10, 10, 10, 10, 10, 50];
    const anomalies = detectAnomalyPoints(values);
    assert.ok(anomalies.length > 0);
    assert.equal(anomalies[0].index, 9);
    assert.ok(anomalies[0].value === 50);
  });

  it("respects custom threshold", () => {
    const values = [10, 10, 10, 10, 10, 10, 10, 10, 10, 15];
    const lowThreshold = detectAnomalyPoints(values, 1.0);
    const highThreshold = detectAnomalyPoints(values, 3.0);
    assert.ok(lowThreshold.length >= highThreshold.length);
  });

  it("assigns correct severity", () => {
    const values = [10, 10, 10, 10, 10, 10, 10, 10, 10, 100];
    const anomalies = detectAnomalyPoints(values);
    assert.ok(anomalies.length > 0);
    assert.ok(["low", "medium", "high"].includes(anomalies[0].severity));
  });
});

describe("detectRecentAnomaly", () => {
  it("returns no anomaly for insufficient data", () => {
    const result = detectRecentAnomaly([1, 2, 3]);
    assert.equal(result.isAnomaly, false);
  });

  it("returns no anomaly for stable data", () => {
    const values = Array(20).fill(10);
    const result = detectRecentAnomaly(values);
    assert.equal(result.isAnomaly, false);
  });

  it("detects spike in recent values", () => {
    // Baseline needs some variance so stdDev > 0
    const baseline = Array.from({ length: 20 }, (_, i) => 10 + (i % 3));
    const spike = Array(5).fill(50);
    const result = detectRecentAnomaly([...baseline, ...spike]);
    assert.equal(result.isAnomaly, true);
    assert.ok(result.zScore > 0);
    assert.ok(result.recentAvg > 40);
  });

  it("detects drop in recent values", () => {
    const baseline = Array.from({ length: 20 }, (_, i) => 50 + (i % 3));
    const drop = Array(5).fill(5);
    const result = detectRecentAnomaly([...baseline, ...drop]);
    assert.equal(result.isAnomaly, true);
    assert.ok(result.zScore < 0);
  });

  it("respects custom threshold", () => {
    const baseline = Array(20).fill(10);
    const slight = Array(5).fill(13);
    const lowResult = detectRecentAnomaly([...baseline, ...slight], 5, 1.0);
    const highResult = detectRecentAnomaly([...baseline, ...slight], 5, 3.0);
    // Slight increase might trigger low threshold but not high
    assert.ok(lowResult.isAnomaly || !highResult.isAnomaly);
  });
});

describe("median / mad", () => {
  it("median handles odd and even lengths", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([]), 0);
  });
  it("mad is robust to outliers", () => {
    const stable = [8, 10, 12, 9, 11, 10, 13, 7];
    const withOutlier = [...stable, 100000];
    const stdDev = (xs: number[]) => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length);
    };
    // MAD barely moves; stdDev explodes by orders of magnitude.
    assert.ok(mad(stable) > 0);
    assert.ok(mad(withOutlier) < mad(stable) * 2);
    assert.ok(stdDev(withOutlier) > stdDev(stable) * 100);
  });
});

describe("classifyMetric", () => {
  it("classifies by name", () => {
    assert.equal(classifyMetric("latency_p99"), "latency");
    assert.equal(classifyMetric("error_rate"), "error_rate");
    assert.equal(classifyMetric("cpu"), "saturation");
    assert.equal(classifyMetric("memory_used_bytes"), "saturation");
    assert.equal(classifyMetric("request_rate"), "throughput");
    assert.equal(classifyMetric("widgets_total"), "generic");
  });
});

describe("detectRobustAnomaly", () => {
  it("warmup: no detection below minSamples", () => {
    const r = detectRobustAnomaly([1, 2, 3, 4, 5]);
    assert.equal(r.isAnomaly, false);
    assert.equal(r.method, "none");
  });

  it("no anomaly for stable noisy data", () => {
    const v = Array.from({ length: 40 }, (_, i) => 100 + (i % 3) - 1);
    assert.equal(detectRobustAnomaly(v).isAnomaly, false);
  });

  // The exact production false-negative: a slow memory-leak ramp toward OOM.
  // detectRecentAnomaly misses it because the rising baseline poisons its own
  // mean/stdDev; detectRobustAnomaly must catch it.
  it("REGRESSION: detects slow memory-leak ramp the legacy detector misses", () => {
    // The query window opened AFTER the leak began, so there is no flat
    // baseline — the metric climbs monotonically across the whole window.
    // Legacy windowed z-score stays sub-threshold (the baseline already
    // contains the ramp); this is the production "all healthy during OOM"
    // false-negative. The robust trend detector must catch it.
    const series = Array.from({ length: 40 }, (_, i) => 120 + i * 7);

    const legacy = detectRecentAnomaly(series, 5, 2.0);
    assert.equal(legacy.isAnomaly, false, "legacy detector misses the leak spanning the window");

    const robust = detectRobustAnomaly(series, { metricKind: "saturation" });
    assert.equal(robust.isAnomaly, true, "robust detector must catch the leak");
    assert.equal(robust.method, "trend");
    assert.equal(robust.direction, "above");
  });

  it("detects a hard spike via robust-z", () => {
    const base = Array.from({ length: 25 }, (_, i) => 50 + (i % 3));
    const spike = Array(5).fill(500);
    const r = detectRobustAnomaly([...base, ...spike], { metricKind: "latency" });
    assert.equal(r.isAnomaly, true);
    assert.equal(r.method, "robust-z");
  });

  it("dwell/hysteresis: a single transient spike does not fire", () => {
    const base = Array.from({ length: 30 }, (_, i) => 50 + (i % 3));
    const series = [...base, 50, 51, 49, 500]; // one lone spike at the very end
    const r = detectRobustAnomaly(series, { metricKind: "latency", dwell: 2 });
    assert.equal(r.isAnomaly, false, "single point should not satisfy dwell");
  });

  it("one-sided: a drop in error_rate is not an anomaly", () => {
    const base = Array.from({ length: 25 }, (_, i) => 20 + (i % 3));
    const drop = Array(5).fill(0);
    const r = detectRobustAnomaly([...base, ...drop], { metricKind: "error_rate" });
    assert.equal(r.isAnomaly, false);
  });

  it("two-sided generic metric flags a drop", () => {
    const base = Array.from({ length: 25 }, (_, i) => 100 + (i % 3));
    const drop = Array(5).fill(5);
    const r = detectRobustAnomaly([...base, ...drop], { metricKind: "generic" });
    assert.equal(r.isAnomaly, true);
    assert.equal(r.direction, "below");
  });
});
