import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculateHealthScore } from "./health.js";
import type { HealthThresholds } from "../types.js";

const defaults: HealthThresholds = {
  weights: { errorRate: 0.35, latency: 0.25, cpu: 0.20, logErrors: 0.20 },
  cpu: { good: 50, warn: 80, crit: 95 },
  errorRate: { good: 0.01, warn: 0.1, crit: 0.5 },
  latencyP99: { good: 0.5, warn: 1.0, crit: 3.0 },
  logErrors: { good: 1, warn: 5, crit: 20 },
  statusBoundaries: { healthy: 80, degraded: 50 },
};

describe("calculateHealthScore", () => {
  it("returns healthy for all-zero inputs", () => {
    const result = calculateHealthScore({
      cpu: 0, memory: 0, errorRate: 0, latencyP99: 0, logErrorRate: 0,
    }, defaults);
    assert.equal(result.status, "healthy");
    assert.equal(result.score, 100);
  });

  it("returns healthy for normal values", () => {
    const result = calculateHealthScore({
      cpu: 20, memory: 100_000_000, errorRate: 0.005, latencyP99: 0.3, logErrorRate: 0,
    }, defaults);
    assert.equal(result.status, "healthy");
    assert.ok(result.score > 80);
  });

  it("returns degraded for elevated values", () => {
    const result = calculateHealthScore({
      cpu: 65, memory: 200_000_000, errorRate: 0.05, latencyP99: 0.8, logErrorRate: 3,
    }, defaults);
    assert.equal(result.status, "degraded");
    assert.ok(result.score > 50 && result.score <= 80, `Expected degraded score 50-80, got ${result.score}`);
  });

  it("returns critical for extreme values", () => {
    const result = calculateHealthScore({
      cpu: 98, memory: 500_000_000, errorRate: 1.0, latencyP99: 5.0, logErrorRate: 50,
    }, defaults);
    assert.equal(result.status, "critical");
    assert.ok(result.score <= 50);
  });

  it("score is between 0 and 100", () => {
    for (const cpu of [0, 50, 100]) {
      for (const err of [0, 0.5, 2]) {
        const result = calculateHealthScore({
          cpu, memory: 0, errorRate: err, latencyP99: 0, logErrorRate: 0,
        }, defaults);
        assert.ok(result.score >= 0 && result.score <= 100, `Score ${result.score} out of range for cpu=${cpu} err=${err}`);
      }
    }
  });

  it("respects custom thresholds", () => {
    const strict: HealthThresholds = {
      ...defaults,
      cpu: { good: 10, warn: 20, crit: 30 },
    };
    const result = calculateHealthScore({
      cpu: 25, memory: 0, errorRate: 0, latencyP99: 0, logErrorRate: 0,
    }, strict);
    // CPU 25% with strict thresholds should lower the score
    assert.ok(result.score < 100);
  });

  it("includes detail breakdown", () => {
    const result = calculateHealthScore({
      cpu: 60, memory: 0, errorRate: 0, latencyP99: 0, logErrorRate: 0,
    }, defaults);
    assert.ok("cpu" in result.details);
    assert.ok("errorRate" in result.details);
    assert.ok(result.details.cpu.score < 100);
  });
});
