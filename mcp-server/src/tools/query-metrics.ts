import type { ConnectorRegistry } from "../connectors/registry.js";
import { defaultContext, type RequestContext } from "../context.js";
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
      groupBy: {
        type: "string",
        description:
          "Optional label to break the result down by, e.g. 'instance', 'pod', 'node'. When set, the response includes a 'groups' array with one time-series per distinct value. When the service has only one matching series, the result is unchanged.",
      },
    },
    required: ["service", "metric"],
  },
};

export async function queryMetricsHandler(
  registry: ConnectorRegistry,
  args: { service: string; metric: string; duration?: string; source?: string; groupBy?: string },
  ctx: RequestContext = defaultContext()
) {
  // Coarse single-tenant source scoping: if the principal is restricted to a
  // source allow-list, deny an explicit out-of-scope source.
  if (
    ctx.allowedSources &&
    args.source &&
    !ctx.allowedSources.includes(args.source)
  ) {
    return errorResponse(
      `forbidden: source "${args.source}" is not in your allowed sources`
    );
  }
  const svcErr = validateServiceName(args.service);
  if (svcErr) return errorResponse(svcErr);
  const duration = args.duration || "5m";
  const durationErr = validateDuration(duration);
  if (durationErr) return errorResponse(durationErr);
  const metricErr = validateMetricName(args.metric, registry);
  if (metricErr) return errorResponse(metricErr);
  if (args.groupBy && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(args.groupBy)) {
    return errorResponse(
      `Invalid groupBy "${args.groupBy}". Must be a valid Prometheus label name (alphanumeric + underscore, starting with letter/underscore).`
    );
  }

  // Tenant-scoped resolution: an explicit `source` from the agent
  // must belong to the caller's tenant (or be a global / untagged
  // source) — cross-tenant sources resolve to undefined exactly like
  // a missing source, preserving the no-existence-leak posture used
  // elsewhere in the tenancy layer.
  const connectors = args.source
    ? [registry.getByNameForTenant(args.source, ctx.tenant)].filter(Boolean)
    : registry.getByTenant(ctx.tenant).filter((c) => c.signalType === "metrics");

  if (connectors.length === 0) {
    // Distinct messages but identical posture: the source-named branch
    // could land here either because the source doesn't exist OR
    // belongs to another tenant — both surface as "not found", same
    // shape, no existence leak. The fan-out branch lands here only on
    // an empty registry.
    const msg = args.source
      ? `Source "${args.source}" not found`
      : "No metrics backends configured";
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
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
        groupBy: args.groupBy,
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
