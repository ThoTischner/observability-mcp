import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculateZScore, detectAnomalyPoints, detectRecentAnomaly } from "./anomaly.js";

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
