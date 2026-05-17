import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as lib from "./index.js";
import { detectAnomaly } from "./anomaly.js";

// Contract test for the embeddable analysis library surface. Guards that the
// public API stays importable in-process (no MCP/transport) and that the
// analyzeMetric façade is exactly the engine path, not a divergent reimpl.
describe("embeddable analysis library", () => {
  it("exposes the documented public API", () => {
    for (const name of [
      "detectAnomaly",
      "detectRobustAnomaly",
      "detectSeasonalAnomaly",
      "rankRootCause",
      "correlateSignals",
      "calculateHealthScore",
      "classifyMetric",
      "analyzeMetric",
    ]) {
      assert.equal(typeof (lib as Record<string, unknown>)[name], "function", `missing export: ${name}`);
    }
  });

  it("analyzeMetric is identical to detectAnomaly with classified kind", () => {
    const points = Array.from({ length: 40 }, (_, i) => ({
      timestamp: 1_700_000_000_000 + i * 60_000,
      value: i < 30 ? 50 + (i % 3) : 800,
    }));
    const viaFacade = lib.analyzeMetric("latency_p99", points);
    const viaEngine = detectAnomaly(points, { metricKind: "latency" });
    assert.deepEqual(viaFacade, viaEngine);
  });

  it("health scoring is callable standalone", () => {
    const r = lib.calculateHealthScore(
      { cpu: 20, memory: 30, errorRate: 0, latencyP99: 0.2, logErrorRate: 0 },
      {
        weights: { errorRate: 1, latency: 1, cpu: 1, logErrors: 1 },
        cpu: { good: 50, warn: 80, crit: 95 },
        errorRate: { good: 1, warn: 5, crit: 10 },
        latencyP99: { good: 0.5, warn: 1, crit: 2 },
        logErrors: { good: 1, warn: 5, crit: 10 },
        statusBoundaries: { healthy: 80, degraded: 50 },
      }
    );
    assert.ok(r.score >= 0 && r.score <= 100);
    assert.ok(["healthy", "degraded", "critical"].includes(r.status as string));
  });
});
