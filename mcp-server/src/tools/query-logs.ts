import type { ConnectorRegistry } from "../connectors/registry.js";
import type { LogResult } from "../types.js";
import { validateDuration, validateServiceName, errorResponse } from "./validation.js";

export const queryLogsDefinition = {
  name: "query_logs" as const,
  description:
    "Query logs for a service over a given timeframe. Returns log entries with a summary including error/warning counts and top error patterns. Supports filtering by log level and search query.",
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
      limit: {
        type: "number",
        description: "Maximum number of log entries to return. Default: 100",
      },
    },
    required: ["service"],
  },
};

export async function queryLogsHandler(
  registry: ConnectorRegistry,
  args: { service: string; query?: string; duration?: string; level?: string; limit?: number }
) {
  const svcErr = validateServiceName(args.service);
  if (svcErr) return errorResponse(svcErr);
  const duration = args.duration || "5m";
  const durationErr = validateDuration(duration);
  if (durationErr) return errorResponse(durationErr);
  const connectors = registry.getBySignal("logs");

  if (connectors.length === 0) {
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ error: "No log backends configured" }) },
      ],
      isError: true,
    };
  }

  const results: LogResult[] = [];
  const errors: string[] = [];
  for (const connector of connectors) {
    if (!connector.queryLogs) continue;
    try {
      const result = await connector.queryLogs({
        service: args.service,
        query: args.query,
        duration,
        level: args.level,
        limit: args.limit,
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
