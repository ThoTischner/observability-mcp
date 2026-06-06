import { test } from "node:test";
import assert from "node:assert/strict";

import { queryTracesHandler, percentile } from "./query-traces.js";
import type { ConnectorRegistry } from "../connectors/registry.js";
import type {
  ObservabilityConnector,
} from "../connectors/interface.js";
import type { TraceResult, TraceSpanSummary } from "../types.js";
import { defaultContext } from "../context.js";

function span(traceId: string, durationMs: number, opts: { hasError?: boolean; service?: string } = {}): TraceSpanSummary {
  return {
    traceId,
    rootName: "GET /pay",
    rootService: opts.service ?? "payment-service",
    durationMs,
    spanCount: 4,
    hasError: opts.hasError ?? false,
    startTs: "2026-06-06T00:00:00.000Z",
  };
}

function fakeRegistry(connectors: Partial<ObservabilityConnector>[]): ConnectorRegistry {
  return {
    getByTenant: (_tenant?: string) => connectors as ObservabilityConnector[],
  } as unknown as ConnectorRegistry;
}

function parseResponse(r: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(r.content[0].text);
}

test("percentile: empty → 0; single value → that value; linear interpolation otherwise", () => {
  assert.equal(percentile([], 0.5), 0);
  assert.equal(percentile([10], 0.5), 10);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  // 95th of [1..20] sits between index 18 (19) and 19 (20)
  const vs = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.ok(percentile(vs, 0.95) >= 19 && percentile(vs, 0.95) <= 20);
});

test("query_traces: rejects invalid service name", async () => {
  const r = await queryTracesHandler(fakeRegistry([]), { service: "bad name with space" });
  assert.equal(r.isError, true);
});

test("query_traces: rejects invalid duration", async () => {
  const r = await queryTracesHandler(fakeRegistry([]), { service: "ok", duration: "bogus" });
  assert.equal(r.isError, true);
});

test("query_traces: no trace backends configured → isError + clear message", async () => {
  // Connectors without queryTraces are skipped.
  const conn = { name: "prom", signalType: "metrics" as const };
  const r = await queryTracesHandler(fakeRegistry([conn]), { service: "ok" });
  assert.equal(r.isError, true);
  assert.match(parseResponse(r).error as string, /No trace backends/);
});

test("query_traces: merges spans from every connector that returned, caps to limit, ranks by duration", async () => {
  const tempo: Partial<ObservabilityConnector> = {
    name: "tempo",
    signalType: "metrics",
    queryTraces: async (): Promise<TraceResult> => ({
      source: "tempo",
      service: "payment",
      traces: [span("aaa", 100), span("bbb", 800), span("ccc", 300)],
      summary: { total: 3, errorCount: 0, p50DurationMs: 300, p95DurationMs: 800 },
    }),
  };
  const jaeger: Partial<ObservabilityConnector> = {
    name: "jaeger",
    signalType: "metrics",
    queryTraces: async (): Promise<TraceResult> => ({
      source: "jaeger",
      service: "payment",
      traces: [span("ddd", 500, { hasError: true }), span("eee", 200)],
      summary: { total: 2, errorCount: 1, p50DurationMs: 350, p95DurationMs: 500 },
    }),
  };
  const r = await queryTracesHandler(
    fakeRegistry([tempo, jaeger]),
    { service: "payment", limit: 4 },
  );
  const body = parseResponse(r) as {
    sources: string[];
    summary: { total: number; errorCount: number; p50DurationMs: number; p95DurationMs: number };
    traces: TraceSpanSummary[];
  };
  assert.deepEqual(body.sources.sort(), ["jaeger", "tempo"]);
  assert.equal(body.traces.length, 4, "limit honoured");
  // Sorted hottest-first
  assert.equal(body.traces[0].durationMs, 800);
  assert.equal(body.traces[1].durationMs, 500);
  assert.equal(body.summary.errorCount, 1);
});

test("query_traces: surfaces per-connector errors but still returns successful results", async () => {
  const ok: Partial<ObservabilityConnector> = {
    name: "tempo",
    signalType: "metrics",
    queryTraces: async () => ({
      source: "tempo",
      service: "payment",
      traces: [span("aaa", 50)],
      summary: { total: 1, errorCount: 0, p50DurationMs: 50, p95DurationMs: 50 },
    }),
  };
  const broken: Partial<ObservabilityConnector> = {
    name: "jaeger",
    signalType: "metrics",
    queryTraces: async () => {
      throw new Error("upstream 503");
    },
  };
  const r = await queryTracesHandler(fakeRegistry([ok, broken]), { service: "payment" });
  const body = parseResponse(r);
  assert.equal((body as { errors: string[] }).errors.length, 1);
  assert.equal((body as { traces: TraceSpanSummary[] }).traces.length, 1);
});

test("query_traces: all backends fail → isError true + errors surfaced", async () => {
  const broken: Partial<ObservabilityConnector> = {
    name: "tempo",
    signalType: "metrics",
    queryTraces: async () => {
      throw new Error("upstream gone");
    },
  };
  const r = await queryTracesHandler(fakeRegistry([broken]), { service: "payment" });
  assert.equal(r.isError, true);
  assert.match(parseResponse(r).error as string, /upstream gone/);
});
