import type { ConnectorRegistry } from "../connectors/registry.js";
import type { MetricResult } from "../types.js";
import { validateDuration, validateMetricName, validateServiceName, errorResponse } from "./validation.js";

export const queryMetricsDefinition = {
  name: "query_metrics" as const,
  description:
    "Query a specific metric for a service over a given timeframe. Returns time-series data with pre-computed summary statistics (current, average, min, max, trend). Available metrics: cpu, memory, error_rate, request_rate, latency_p99, latency_p50, latency_avg.",
  inputSchema: {
    type: "object" as const,
    properties: {
      service: {
        type: "string",
        description: "Service name (e.g. 'api-gateway', 'payment-service')",
      },
      metric: {
        type: "string",
        description:
          "Metric name: cpu, memory, error_rate, request_rate, latency_p99, latency_p50, latency_avg",
      },
      duration: {
        type: "string",
        description: "Time range to query (e.g. '5m', '1h', '24h'). Default: '5m'",
      },
      source: {
        type: "string",
        description: "Specific source name to query. If omitted, queries all metrics backends.",
      },
    },
    required: ["service", "metric"],
  },
};

export async function queryMetricsHandler(
  registry: ConnectorRegistry,
  args: { service: string; metric: string; duration?: string; source?: string }
) {
  const svcErr = validateServiceName(args.service);
  if (svcErr) return errorResponse(svcErr);
  const duration = args.duration || "5m";
  const durationErr = validateDuration(duration);
  if (durationErr) return errorResponse(durationErr);
  const metricErr = validateMetricName(args.metric, registry);
  if (metricErr) return errorResponse(metricErr);

  const connectors = args.source
    ? [registry.getByName(args.source)].filter(Boolean)
    : registry.getBySignal("metrics");

  if (connectors.length === 0) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: "No metrics backends configured" }) }],
      isError: true,
    };
  }

  const results: MetricResult[] = [];
  const errors: string[] = [];
  for (const connector of connectors) {
    if (!connector?.queryMetrics) continue;
    try {
      const result = await connector.queryMetrics({
        service: args.service,
        metric: args.metric,
        duration,
      });
      results.push(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Metrics query failed on ${connector.name}:`, msg);
      errors.push(`${connector.name}: ${msg}`);
    }
  }

  if (results.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: errors.length > 0 ? `Query failed: ${errors.join("; ")}` : "No data returned",
            service: args.service,
            metric: args.metric,
            duration,
          }),
        },
      ],
      isError: errors.length > 0,
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(results.length === 1 ? results[0] : results, null, 2),
      },
    ],
  };
}
