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
    // buildQuery is private async and returns `{ promql, label, candidate }`.
    // To keep these tests off the network, every case uses a user-
    // override metric — that short-circuits the candidate-probe path
    // (which would otherwise call Prometheus to pick the best variant
    // and resolveServiceLabel to discover the right scoping label).
    // The label / candidate fields are exercised via the public
    // queryMetrics path elsewhere.
    const fakeSource = { name: "test", type: "prometheus" as const, url: "http://localhost:9090", enabled: true };

    it("replaces {{service}} placeholder in user-defined metrics", async () => {
      const connector = new PrometheusConnector();
      await connector.connect({
        ...fakeSource,
        metrics: [{ name: "cpu", query: 'cpu_usage{svc="{{service}}"}', unit: "%", description: "CPU" }],
      });
      const { promql } = await proto.buildQuery.call(connector, "payment-service", "cpu");
      assert.ok(promql.includes("payment-service"));
      assert.ok(!promql.includes("{{service}}"));
    });

    it("respects an explicit {{service}} substitution outside the {{selector}} sugar", async () => {
      // Different from the other two: the override here uses {{service}}
      // directly inside a hand-written selector (no {{selector}} sugar).
      // Confirms the substitution applies to the raw template, not only
      // through the label-resolver path.
      const connector = new PrometheusConnector();
      await connector.connect({
        ...fakeSource,
        metrics: [{ name: "explicit_selector", query: 'explicit_metric{job="{{service}}"}', unit: "", description: "" }],
      });
      const { promql } = await proto.buildQuery.call(connector, "my-svc", "explicit_selector");
      assert.equal(promql, 'explicit_metric{job="my-svc"}');
    });

    it("uses custom metrics from source config", async () => {
      const connector = new PrometheusConnector();
      await connector.connect({
        ...fakeSource,
        metrics: [{ name: "custom", query: 'my_custom_metric{svc="{{service}}"}', unit: "ops", description: "Custom" }],
      });
      const { promql } = await proto.buildQuery.call(connector, "api", "custom");
      assert.equal(promql, 'my_custom_metric{svc="api"}');
    });

    it("AND's labels into the {{selector}} (issue #415 #4)", async () => {
      const connector = new PrometheusConnector();
      await connector.connect({
        ...fakeSource,
        metrics: [{ name: "reqs", query: "http_requests_total{ {{selector}} }", unit: "", description: "" }],
      });
      // Stub the network label-resolver so the test is hermetic.
      (connector as unknown as { resolveServiceLabel: () => Promise<string> }).resolveServiceLabel =
        async () => "job";
      const { promql } = await proto.buildQuery.call(connector, "api", "reqs", undefined, {
        status: "500",
        route: "/checkout",
      });
      // Insertion order preserved: status then route, after the service matcher.
      assert.equal(promql, 'http_requests_total{ job="api", status="500", route="/checkout" }');
    });

    it("escapes quotes/backslashes in label values (PromQL injection guard)", async () => {
      const connector = new PrometheusConnector();
      await connector.connect({
        ...fakeSource,
        metrics: [{ name: "reqs", query: "http_requests_total{ {{selector}} }", unit: "", description: "" }],
      });
      (connector as unknown as { resolveServiceLabel: () => Promise<string> }).resolveServiceLabel =
        async () => "job";
      const { promql } = await proto.buildQuery.call(connector, "api", "reqs", undefined, {
        path: 'a"b\\c',
      });
      assert.equal(promql, 'http_requests_total{ job="api", path="a\\"b\\\\c" }');
    });

    it("escapes newlines/control chars in label values (Loki parity)", async () => {
      const connector = new PrometheusConnector();
      await connector.connect({
        ...fakeSource,
        metrics: [{ name: "reqs", query: "http_requests_total{ {{selector}} }", unit: "", description: "" }],
      });
      (connector as unknown as { resolveServiceLabel: () => Promise<string> }).resolveServiceLabel =
        async () => "job";
      const { promql } = await proto.buildQuery.call(connector, "api", "reqs", undefined, {
        note: "a\nb\tc",
      });
      assert.equal(promql, 'http_requests_total{ job="api", note="a\\nb\\tc" }');
    });

    it("ignores labels when the template has no {{selector}}", async () => {
      const connector = new PrometheusConnector();
      await connector.connect({
        ...fakeSource,
        metrics: [{ name: "explicit", query: 'm{job="{{service}}"}', unit: "", description: "" }],
      });
      const { promql } = await proto.buildQuery.call(connector, "svc", "explicit", undefined, {
        status: "500",
      });
      assert.equal(promql, 'm{job="svc"}');
    });
  });

  describe("queryMetrics rawQuery passthrough (R4, issue #415 #3)", () => {
    const fakeSource = { name: "test", type: "prometheus" as const, url: "http://localhost:9090", enabled: true };

    it("sends raw PromQL verbatim to query_range, bypassing the catalog", async () => {
      const connector = new PrometheusConnector();
      await connector.connect({ ...fakeSource });
      let captured = "";
      const orig = globalThis.fetch;
      globalThis.fetch = (async (url: any) => {
        captured = decodeURIComponent((String(url).match(/query=([^&]+)/) || [])[1] || "");
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { result: [{ metric: { foo: "bar" }, values: [[1700000000, "42"]] }] } }),
        } as any;
      }) as any;
      try {
        const raw = "topk(5, sum by(route) (rate(http_requests_total[5m])))";
        const result = await connector.queryMetrics({ service: "", metric: "", duration: "15m", rawQuery: raw });
        assert.equal(captured, raw);
        assert.equal(result.resolvedSeries, raw);
        assert.equal(result.metric, "(raw)");
        assert.equal(result.values[0].value, 42);
      } finally {
        globalThis.fetch = orig;
      }
    });
  });
});
