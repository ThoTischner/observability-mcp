// get_anomaly_history — Phase F15.
//
// Reads anomaly scores previously written to the TSDB by the
// AnomalyHistory writer. The tool is a thin convenience wrapper: it
// builds the PromQL query `omcp_anomaly_score{service="..."}` and
// dispatches via any Prometheus-shaped connector in the caller's
// tenant.
//
// Operators wire the round-trip themselves (Prometheus scrapes the
// same remote-write endpoint the writer pushes to) — the gateway
// doesn't need a direct TSDB query path because it already speaks
// PromQL via the Prometheus connector.

import type { ConnectorRegistry } from "../connectors/registry.js";
import { defaultContext, type RequestContext } from "../context.js";
import { validateDuration, validateServiceName, errorResponse } from "./validation.js";

export const getAnomalyHistoryDefinition = {
  name: "get_anomaly_history" as const,
  description: [
    "Replay historical anomaly scores for a service from the TSDB the gateway writes to (omcp_anomaly_score series).",
    "When to use: post-mortem reconstruction (what did the gateway see at 03:42?), trend analysis on detector noise, or pulling context for the LLM when an incident is reviewed after the fact.",
    "Prerequisites: the operator must have OMCP_ANOMALY_HISTORY_REMOTE_WRITE configured AND a Prometheus connector pointed at the same TSDB so the round-trip closes.",
    "Behavior: read-only. Returns the time-series of scores with per-method/severity labels. Empty result means either no anomalies in the window or history is disabled.",
    "Related: `detect_anomalies` for the live scores; `query_metrics` if you want to write the PromQL by hand.",
  ].join(" "),
  inputSchema: {
    type: "object" as const,
    properties: {
      service: { type: "string", description: "Service name to filter on." },
      duration: { type: "string", description: "Rolling window (e.g. '1h', '24h'). Default '1h'." },
      method: { type: "string", description: "Filter by detector method ('mad', 'seasonality', 'correlator'). Optional." },
    },
    required: ["service"],
  },
};

export async function getAnomalyHistoryHandler(
  registry: ConnectorRegistry,
  args: { service: string; duration?: string; method?: string },
  ctx: RequestContext = defaultContext(),
) {
  const svcErr = validateServiceName(args.service);
  if (svcErr) return errorResponse(svcErr);
  const duration = args.duration || "1h";
  const durationErr = validateDuration(duration);
  if (durationErr) return errorResponse(durationErr);

  // Pick any metrics connector. The operator is expected to have
  // their TSDB scraped by Prometheus, so any metric source can serve
  // the query. We don't try to auto-detect "the right source" — the
  // query is global by metric name.
  const candidates = registry
    .getByTenant(ctx.tenant)
    .filter((c) => typeof c.queryMetrics === "function");

  if (candidates.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error:
              "No metrics backend configured to query the TSDB. Configure a Prometheus source pointed at the same TSDB OMCP_ANOMALY_HISTORY_REMOTE_WRITE writes to.",
          }),
        },
      ],
      isError: true,
    };
  }

  // Build the PromQL. The recording metric `omcp_anomaly_score` is
  // expected to exist; if the writer is disabled or never fired, the
  // query just returns an empty series — that's a valid result.
  const labelFilters: string[] = [`service="${escLabel(args.service)}"`];
  if (args.method) labelFilters.push(`method="${escLabel(args.method)}"`);
  const metric = `omcp_anomaly_score{${labelFilters.join(",")}}`;

  // Fan out across every metrics connector; first non-empty answer wins.
  // CRITICAL: pass the hand-built selector via `rawQuery`, NOT `metric`.
  // The connector's curated path wraps a bare `metric` in `{ {{selector}} }`,
  // which for our already-complete selector produces invalid double-brace
  // PromQL (`omcp_anomaly_score{service="x"}{ job="x" }`) → 400 → the catch
  // below swallowed it and the tool always reported "no history". rawQuery is
  // sent verbatim to /api/v1/query_range (the R4 passthrough).
  for (const c of candidates) {
    if (!c.queryMetrics) continue;
    try {
      const r = await c.queryMetrics({
        service: args.service,
        metric: "omcp_anomaly_score",
        rawQuery: metric,
        duration,
      });
      if (r && Array.isArray(r.values) && r.values.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                service: args.service,
                duration,
                method: args.method,
                source: r.source,
                values: r.values,
                summary: r.summary,
                metric,
              }),
            },
          ],
          isError: false,
        };
      }
    } catch (err) {
      console.warn(
        "get_anomaly_history: %s threw: %s",
        c.name,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // No connector returned data — either the metric doesn't exist or
  // there were no anomalies in the window. Both are useful answers.
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          service: args.service,
          duration,
          method: args.method,
          values: [],
          summary: { count: 0 },
          metric,
          hint:
            "No anomaly history found. Either the window is clean, or OMCP_ANOMALY_HISTORY_REMOTE_WRITE was unset when the anomalies fired, or the configured Prometheus source isn't scraping the TSDB this writer pushes to.",
        }),
      },
    ],
    isError: false,
  };
}

/** Escape a PromQL label value (backslash + double-quote). */
function escLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
