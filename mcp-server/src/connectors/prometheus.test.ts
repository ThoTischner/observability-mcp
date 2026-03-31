import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PrometheusConnector } from "./prometheus.js";
import type { SourceConfig } from "../types.js";

// Access private methods via prototype for testing pure logic
const proto = PrometheusConnector.prototype as any;

describe("PrometheusConnector", () => {
  describe("parseTimeRange", () => {
    it("parses minutes", () => {
      const { start, end, step } = proto.parseTimeRange("5m");
      assert.ok(end - start >= 299 && end - start <= 301); // ~300s
      assert.equal(step, "5s"); // max(floor(300/100), 5) = 5
    });

    it("parses hours", () => {
      const { start, end, step } = proto.parseTimeRange("1h");
      assert.ok(end - start >= 3599 && end - start <= 3601); // ~3600s
      assert.equal(step, "36s"); // floor(3600/100) = 36
    });

    it("parses days", () => {
      const { start, end, step } = proto.parseTimeRange("7d");
      assert.ok(end - start >= 604799 && end - start <= 604801);
      assert.equal(step, "6048s"); // floor(604800/100)
    });

    it("uses custom step when provided", () => {
      const { step } = proto.parseTimeRange("1h", "15s");
      assert.equal(step, "15s");
    });

    it("throws on invalid duration", () => {
      assert.throws(() => proto.parseTimeRange("invalid"));
      assert.throws(() => proto.parseTimeRange("5s"));
      assert.throws(() => proto.parseTimeRange(""));
    });
  });

  describe("computeTrend", () => {
    it("returns stable for fewer than 4 values", () => {
      assert.equal(proto.computeTrend([1, 2, 3]), "stable");
      assert.equal(proto.computeTrend([1]), "stable");
      assert.equal(proto.computeTrend([]), "stable");
    });

    it("detects rising trend", () => {
      assert.equal(proto.computeTrend([1, 1, 10, 10]), "rising");
      assert.equal(proto.computeTrend([1, 2, 5, 8, 10, 15]), "rising");
    });

    it("detects falling trend", () => {
      assert.equal(proto.computeTrend([10, 10, 1, 1]), "falling");
      assert.equal(proto.computeTrend([20, 18, 5, 3, 2, 1]), "falling");
    });

    it("returns stable for flat data", () => {
      assert.equal(proto.computeTrend([5, 5, 5, 5]), "stable");
      assert.equal(proto.computeTrend([10, 10.5, 10, 10.5]), "stable");
    });

    it("returns stable for small changes within 10%", () => {
      assert.equal(proto.computeTrend([100, 100, 105, 105]), "stable");
    });
  });

  describe("computeSummary", () => {
    it("returns zeros for empty array", () => {
      const s = proto.computeSummary([]);
      assert.equal(s.current, 0);
      assert.equal(s.average, 0);
      assert.equal(s.min, 0);
      assert.equal(s.max, 0);
      assert.equal(s.trend, "stable");
    });

    it("computes correct summary for values", () => {
      const s = proto.computeSummary([10, 20, 30, 40]);
      assert.equal(s.current, 40);
      assert.equal(s.average, 25);
      assert.equal(s.min, 10);
      assert.equal(s.max, 40);
    });

    it("handles single value", () => {
      const s = proto.computeSummary([42]);
      assert.equal(s.current, 42);
      assert.equal(s.average, 42);
      assert.equal(s.min, 42);
      assert.equal(s.max, 42);
    });
  });

  describe("buildQuery", () => {
    it("replaces {{service}} placeholder in known metrics", async () => {
      const connector = new PrometheusConnector();
      await connector.connect({ name: "test", type: "prometheus", url: "http://localhost:9090", enabled: true });
      const query = proto.buildQuery.call(connector, "payment-service", "cpu");
      assert.ok(query.includes("payment-service"));
      assert.ok(!query.includes("{{service}}"));
    });

    it("falls back to generic query for unknown metrics", async () => {
      const connector = new PrometheusConnector();
      await connector.connect({ name: "test", type: "prometheus", url: "http://localhost:9090", enabled: true });
      const query = proto.buildQuery.call(connector, "my-svc", "unknown_metric");
      assert.equal(query, 'unknown_metric{job="my-svc"}');
    });

    it("uses custom metrics from source config", async () => {
      const connector = new PrometheusConnector();
      await connector.connect({
        name: "test", type: "prometheus", url: "http://localhost:9090", enabled: true,
        metrics: [{ name: "custom", query: 'my_custom_metric{svc="{{service}}"}', unit: "ops", description: "Custom" }],
      });
      const query = proto.buildQuery.call(connector, "api", "custom");
      assert.equal(query, 'my_custom_metric{svc="api"}');
    });
  });
});
