// query_traces — Phase F13.
//
// Surfaces distributed traces from any connector that implements the
// queryTraces capability. Fans out across every traces-signal
// connector in the caller's tenant, merges the returned trace
// summaries, and recomputes a global p50/p95 over the merged set
// (rather than blindly averaging per-source summaries).
//
// Backend support today: a Tempo connector + a Jaeger shim ship as
// filesystem plugins. Any connector that implements queryTraces
// participates automatically — no changes needed in the tool layer
// when a new backend lands.

import type { ConnectorRegistry } from "../connectors/registry.js";
import { defaultContext, type RequestContext } from "../context.js";
import type { TraceResult, TraceSpanSummary, TraceSummary } from "../types.js";
import { validateDuration, validateServiceName, errorResponse } from "./validation.js";

export const queryTracesDefinition = {
  name: "query_traces" as const,
  description: [
    "Query distributed traces for a service over a given timeframe.",
    "Returns ranked trace summaries with duration, error status, and span count, plus a p50/p95 duration aggregate across the returned set.",
    "When to use: investigating tail-latency outliers, walking call chains across services for a known time window, or pulling related traces for an anomaly the metric/log tools surfaced first.",
    "Behavior: read-only; results may be capped via `limit` (default 50). `filter` accepts the backend's native query language (TraceQL on Tempo, tag query on Jaeger). When `errorsOnly=true`, only traces with at least one error span are returned.",
    "Related: `query_metrics` for the per-service latency series; `get_blast_radius` for the topology a trace traverses.",
  ].join(" "),
  inputSchema: {
    type: "object" as const,
    properties: {
      service: { type: "string", description: "Service name (e.g. 'payment-service')" },
      duration: { type: "string", description: "Rolling time window (e.g. '5m', '1h'). Default '15m'." },
      filter: { type: "string", description: "Backend-native filter (TraceQL on Tempo, tag query on Jaeger). Optional." },
      limit: { type: "number", description: "Soft cap on returned trace summaries. Default 50." },
      errorsOnly: { type: "boolean", description: "If true, only traces with at least one error span." },
    },
    required: ["service"],
  },
};

export async function queryTracesHandler(
  registry: ConnectorRegistry,
  args: { service: string; duration?: string; filter?: string; limit?: number; errorsOnly?: boolean },
  ctx: RequestContext = defaultContext(),
) {
  const svcErr = validateServiceName(args.service);
  if (svcErr) return errorResponse(svcErr);
  const duration = args.duration || "15m";
  const durationErr = validateDuration(duration);
  if (durationErr) return errorResponse(durationErr);

  // signalType filter: traces-aware connectors should report "traces"
  // (the new signal type) but we also accept any connector that
  // declares queryTraces — back-compat for connectors that haven't
  // updated their signalType yet.
  const candidates = registry
    .getByTenant(ctx.tenant)
    .filter((c) => typeof c.queryTraces === "function");

  if (candidates.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: "No trace backends configured" }),
        },
      ],
      isError: true,
    };
  }

  const results: TraceResult[] = [];
  const errors: string[] = [];
  for (const connector of candidates) {
    if (!connector.queryTraces) continue;
    try {
      const r = await connector.queryTraces({
        service: args.service,
        duration,
        filter: args.filter,
        limit: args.limit,
        errorsOnly: args.errorsOnly,
      });
      results.push(r);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Trace query failed on ${connector.name}:`, msg);
      errors.push(`${connector.name}: ${msg}`);
    }
  }

  if (results.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: errors.length > 0 ? `Query failed: ${errors.join("; ")}` : "No traces returned",
            service: args.service,
            duration,
          }),
        },
      ],
      isError: errors.length > 0,
    };
  }

  // Merge: every source returns its own ranked set; we keep the union
  // and recompute a global p50/p95 over the merged set so the summary
  // reflects what the tool actually returned to the caller.
  const merged: TraceSpanSummary[] = [];
  for (const r of results) merged.push(...r.traces);
  // Sort hottest-first by duration, then truncate to the requested limit.
  merged.sort((a, b) => b.durationMs - a.durationMs);
  const limit = args.limit ?? 50;
  const capped = merged.slice(0, limit);

  const errorCount = capped.filter((t) => t.hasError).length;
  const summary: TraceSummary = {
    total: capped.length,
    errorCount,
    p50DurationMs: percentile(capped.map((t) => t.durationMs), 0.5),
    p95DurationMs: percentile(capped.map((t) => t.durationMs), 0.95),
  };

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          service: args.service,
          duration,
          sources: results.map((r) => r.source),
          summary,
          traces: capped,
          errors: errors.length > 0 ? errors : undefined,
        }),
      },
    ],
    isError: false,
  };
}

/** Pure percentile over a numeric array. Returns 0 for empty input. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // Linear interpolation between the two surrounding samples.
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo] ?? 0;
  const frac = rank - lo;
  return Math.round((sorted[lo] ?? 0) * (1 - frac) + (sorted[hi] ?? 0) * frac);
}
