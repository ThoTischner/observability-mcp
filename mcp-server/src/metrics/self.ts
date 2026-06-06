// Server self-metrics exposed at /metrics for Prometheus scraping.
// Pairs with the Helm chart's ServiceMonitor template.
//
// Default Node metrics (CPU, memory, event loop lag, heap) come from
// prom-client's collectDefaultMetrics. On top of that we ship four
// product-specific counters/histograms that operators actually need
// to graph: MCP tool calls, connector backend calls, /api/* requests,
// active session count.

import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Histogram,
  Gauge,
} from "prom-client";

export const selfRegistry = new Registry();
selfRegistry.setDefaultLabels({ service: "observability-mcp" });
collectDefaultMetrics({ register: selfRegistry, prefix: "obsmcp_" });

export const mcpToolCalls = new Counter({
  name: "obsmcp_mcp_tool_calls_total",
  help: "MCP tool invocations by tool and outcome.",
  labelNames: ["tool", "outcome"] as const,
  registers: [selfRegistry],
});

export const mcpToolLatency = new Histogram({
  name: "obsmcp_mcp_tool_duration_seconds",
  help: "MCP tool invocation latency.",
  labelNames: ["tool"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [selfRegistry],
});

export const connectorCalls = new Counter({
  name: "obsmcp_connector_calls_total",
  help: "Calls to a configured connector, by source and outcome.",
  labelNames: ["source", "type", "operation", "outcome"] as const,
  registers: [selfRegistry],
});

export const apiRequests = new Counter({
  name: "obsmcp_api_requests_total",
  help: "Web UI / API request count, by route and status.",
  labelNames: ["route", "method", "status"] as const,
  registers: [selfRegistry],
});

export const mcpActiveSessions = new Gauge({
  name: "obsmcp_mcp_active_sessions",
  help: "Active MCP Streamable HTTP sessions.",
  registers: [selfRegistry],
});

// P9: Audit webhook dead-letter queue depth. Refreshed on each
// `/metrics` scrape and when the operator hits `/api/audit/dlq`.
// Stays at 0 when no DLQ file is configured or the file is missing.
export const auditDlqDepth = new Gauge({
  name: "obsmcp_audit_webhook_dlq_depth",
  help: "Number of audit entries waiting in the webhook-sink dead-letter queue.",
  registers: [selfRegistry],
});

/**
 * Wrap a (potentially async) tool handler to record call count + latency.
 * Outcome is "ok" or "error" — never throws on its own.
 */
export async function withToolMetrics<T>(
  tool: string,
  fn: () => Promise<T>,
): Promise<T> {
  const end = mcpToolLatency.startTimer({ tool });
  try {
    const r = await fn();
    mcpToolCalls.inc({ tool, outcome: "ok" });
    return r;
  } catch (err) {
    mcpToolCalls.inc({ tool, outcome: "error" });
    throw err;
  } finally {
    end();
  }
}
