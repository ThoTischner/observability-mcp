import type { ConnectorRegistry } from "../connectors/registry.js";
import { defaultContext, type RequestContext } from "../context.js";
import type { LogResult, LogAggregateResult, LogAggregateQuery } from "../types.js";
import { validateDuration, validateServiceName, validateLogLabels, validateLogAggregate, validateRawQuery, errorResponse } from "./validation.js";

export const queryLogsDefinition = {
  name: "query_logs" as const,
  description:
    "Query logs for a service over a given timeframe. Returns log entries with a summary including error/warning counts and top error patterns. Filter by log level, a free-text/regex search, OR structured `labels` (exact-match on backend-extracted fields like method/status/url/environment — far more reliable than regex on structured JSON logs).",
  inputSchema: {
    type: "object" as const,
    properties: {
      service: {
        type: "string",
        description: "Service name (e.g. 'payment-service')",
      },
      query: {
        type: "string",
        description: "Optional search query to filter log messages (regex supported)",
      },
      duration: {
        type: "string",
        description: "Time range to query (e.g. '5m', '1h', '24h'). Default: '5m'",
      },
      level: {
        type: "string",
        description: "Filter by log level: 'error', 'warn', 'info', 'debug'",
      },
      labels: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          "Structured equality filters on backend-extracted fields, AND'd together, e.g. {\"method\":\"GET\",\"url\":\"/\",\"status\":\"200\",\"environment\":\"prod\"}. Prefer this over `query` for structured JSON logs — the literal text rarely appears verbatim. Label names must be [a-zA-Z_][a-zA-Z0-9_]* (max 20).",
      },
      limit: {
        type: "number",
        description: "Maximum number of log entries to return. Default: 100. Ignored when `aggregate` is set.",
      },
      aggregate: {
        type: "object",
        description:
          "Server-side aggregation — returns grouped counts, not raw rows, so you get a number instead of a haystack. op: 'count_over_time' (time series of counts per bucket), 'sum' (total per group over the window), 'topk' (top-k groups by total). Example: {\"op\":\"topk\",\"by\":[\"url\"],\"k\":10} for the busiest paths. Honours `labels`/`query` filters.",
        properties: {
          op: { type: "string", enum: ["count_over_time", "sum", "topk"] },
          by: { type: "array", items: { type: "string" }, description: "Group-by label names (required for topk)." },
          k: { type: "number", description: "Top-k count (default 10)." },
          step: { type: "string", description: "Bucket size for count_over_time, e.g. '15m'. Defaults to ~1/60th of the window." },
        },
        required: ["op"],
      },
    },
    required: ["service"],
  },
};

export async function queryLogsHandler(
  registry: ConnectorRegistry,
  args: {
    service?: string;
    query?: string;
    duration?: string;
    level?: string;
    limit?: number;
    labels?: Record<string, string>;
    aggregate?: { op: "count_over_time" | "sum" | "topk"; by?: string[]; k?: number; step?: string };
    raw_query?: string;
  },
  ctx: RequestContext = defaultContext(),
  opts: { allowRawQuery?: boolean } = {}
) {
  const duration = args.duration || "5m";
  const durationErr = validateDuration(duration);
  if (durationErr) return errorResponse(durationErr);

  // Raw LogQL passthrough — capability-gated, default off. Bypasses the curated
  // stream-selector construction, so `service` is not required and is ignored.
  // Mutually exclusive with `aggregate` (for metric LogQL use `aggregate`).
  const rawErr = validateRawQuery(args.raw_query);
  if (rawErr) return errorResponse(rawErr);
  const isRaw = !!args.raw_query;
  if (isRaw && !opts.allowRawQuery) {
    return errorResponse(
      "raw_query is disabled. The operator must enable the raw-query capability (OMCP_RAW_QUERY=on globally, or per-credential via OMCP_KEY_RAW_QUERY) to run verbatim LogQL — it bypasses the curated log surface, so it is off by default."
    );
  }
  if (isRaw && args.aggregate) {
    return errorResponse("raw_query and aggregate are mutually exclusive — a raw LogQL query expresses its own aggregation.");
  }

  if (!isRaw) {
    if (!args.service) return errorResponse("service is required (or set raw_query).");
    const svcErr = validateServiceName(args.service);
    if (svcErr) return errorResponse(svcErr);
    const labelsErr = validateLogLabels(args.labels);
    if (labelsErr) return errorResponse(labelsErr);
    const aggErr = validateLogAggregate(args.aggregate);
    if (aggErr) return errorResponse(aggErr);
  }
  const connectors = registry.getByTenant(ctx.tenant).filter((c) => c.signalType === "logs");

  if (connectors.length === 0) {
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ error: "No log backends configured" }) },
      ],
      isError: true,
    };
  }

  // Aggregate mode (Q-LOG2): route to the connector's queryLogAggregate.
  if (args.aggregate) {
    const aggResults: LogAggregateResult[] = [];
    const aggErrors: string[] = [];
    let capable = 0;
    for (const connector of connectors) {
      if (!connector.queryLogAggregate) continue;
      capable++;
      try {
        const q: LogAggregateQuery = {
          service: args.service ?? "",
          duration,
          labels: args.labels,
          query: args.query,
          op: args.aggregate.op,
          by: args.aggregate.by,
          k: args.aggregate.k,
          step: args.aggregate.step,
        };
        aggResults.push(await connector.queryLogAggregate(q));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Log aggregate failed on ${connector.name}:`, msg);
        aggErrors.push(`${connector.name}: ${msg}`);
      }
    }
    if (capable === 0) {
      return errorResponse("No log backend supports aggregation (queryLogAggregate).");
    }
    if (aggResults.length === 0) {
      return {
        // `window` = the requested look-back, not elapsed time (issue #452).
        content: [{ type: "text" as const, text: JSON.stringify({ error: aggErrors.length ? `Aggregate failed: ${aggErrors.join("; ")}` : "No data returned", service: args.service, window: duration }) }],
        isError: aggErrors.length > 0,
      };
    }
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(aggResults.length === 1 ? aggResults[0] : aggResults, null, 2) },
      ],
    };
  }

  const results: LogResult[] = [];
  const errors: string[] = [];
  for (const connector of connectors) {
    if (!connector.queryLogs) continue;
    try {
      const result = await connector.queryLogs({
        service: args.service ?? "",
        query: args.query,
        duration,
        level: args.level,
        limit: args.limit,
        labels: args.labels,
        rawQuery: args.raw_query,
      });
      results.push(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Log query failed on ${connector.name}:`, msg);
      errors.push(`${connector.name}: ${msg}`);
    }
  }

  if (results.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: errors.length > 0 ? `Query failed: ${errors.join("; ")}` : "No logs returned",
            service: args.service,
            // The requested look-back window, NOT elapsed wall-clock time. Named
            // `window` so a fast failure isn't misread as a 5-minute hang (#452).
            window: duration,
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
