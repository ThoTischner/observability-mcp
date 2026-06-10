import type { ConnectorRegistry } from "../connectors/registry.js";
import { defaultContext, type RequestContext } from "../context.js";
import type { ServiceHealth, AnomalyReport, HealthThresholds } from "../types.js";
import { calculateHealthScore } from "../analysis/health.js";
import { detectRobustAnomaly, classifyMetric } from "../analysis/anomaly.js";
import { sanitizeForLog } from "../util/sanitize.js";

let _thresholds: HealthThresholds | null = null;

export function setHealthThresholds(t: HealthThresholds) {
  _thresholds = t;
}

export const getServiceHealthDefinition = {
  name: "get_service_health" as const,
  description:
    "Get an aggregated health overview for a service combining metrics AND logs. Returns a health score (0-100), status (healthy/degraded/critical), key metric values, log error summary, detected anomalies, and cross-signal correlations.",
  inputSchema: {
    type: "object" as const,
    properties: {
      service: {
        type: "string",
        description: "Service name to check health for",
      },
    },
    required: ["service"],
  },
};

export async function getServiceHealthHandler(
  registry: ConnectorRegistry,
  args: { service: string },
  ctx: RequestContext = defaultContext()
) {
  const tenantConnectors = registry.getByTenant(ctx.tenant);
  const metricsConnectors = tenantConnectors.filter((c) => c.signalType === "metrics");
  const logConnectors = tenantConnectors.filter((c) => c.signalType === "logs");

  // Gather metrics. Track whether any series actually returned data —
  // absent metrics must NOT be coerced to 0 and read as a confident
  // "healthy" (issue #453).
  let cpu = 0, memory = 0, errorRate = 0, latencyP99 = 0;
  let metricsHadData = false;
  const anomalies: AnomalyReport[] = [];

  for (const connector of metricsConnectors) {
    if (!connector.queryMetrics) continue;
    try {
      const cpuResult = await connector.queryMetrics({ service: args.service, metric: "cpu", duration: "5m" });
      if (cpuResult.values.length > 0) { cpu = cpuResult.summary.current; metricsHadData = true; }
      checkAnomaly(cpuResult.values.map(v => v.value), "cpu", args.service, connector.name, anomalies);

      const memResult = await connector.queryMetrics({ service: args.service, metric: "memory", duration: "5m" });
      if (memResult.values.length > 0) { memory = memResult.summary.current / 1_000_000; metricsHadData = true; } // MB for display

      const errResult = await connector.queryMetrics({ service: args.service, metric: "error_rate", duration: "5m" });
      if (errResult.values.length > 0) { errorRate = errResult.summary.current; metricsHadData = true; }
      checkAnomaly(errResult.values.map(v => v.value), "error_rate", args.service, connector.name, anomalies);

      const latResult = await connector.queryMetrics({ service: args.service, metric: "latency_p99", duration: "5m" });
      if (latResult.values.length > 0) { latencyP99 = latResult.summary.current; metricsHadData = true; }
      checkAnomaly(latResult.values.map(v => v.value), "latency_p99", args.service, connector.name, anomalies);
    } catch (err) {
      console.error("Health check metrics failed for %s:", sanitizeForLog(args.service), err);
    }
  }

  // Gather logs
  let logErrorRate = 0;
  let topErrors: string[] = [];
  let logsHadData = false;
  const correlations: string[] = [];

  for (const connector of logConnectors) {
    if (!connector.queryLogs) continue;
    try {
      const logs = await connector.queryLogs({ service: args.service, duration: "5m", limit: 200 });
      if (logs.summary.total > 0) logsHadData = true; // real log coverage in the window
      logErrorRate = logs.summary.errorCount; // errors in 5m window
      topErrors = logs.summary.topPatterns;

      // Cross-signal correlation
      if (logErrorRate > 0 && anomalies.length > 0) {
        correlations.push(
          `${anomalies.length} metric anomal${anomalies.length === 1 ? "y" : "ies"} detected alongside ${logErrorRate} error logs in the last 5 minutes`
        );
        if (topErrors.length > 0) {
          correlations.push(`Top error pattern: ${topErrors[0]}`);
        }
      }
    } catch (err) {
      console.error("Health check logs failed for %s:", sanitizeForLog(args.service), err);
    }
  }

  // Honest signal coverage: judge the service only on the families that
  // actually returned data, so a log-only (or absent) service is never
  // coerced to a confident "healthy" from metric zeros (issue #453).
  const coverage = { metrics: metricsHadData, logs: logsHadData };

  // No data at all → either the service doesn't exist (typo / decommissioned)
  // or it isn't monitored. Say so explicitly, like the other tools' empty
  // states — don't return 100/healthy.
  if (!metricsHadData && !logsHadData) {
    const known = await knownServiceNames(tenantConnectors, args.service);
    const note = known
      ? `No metric or log data for "${args.service}" in the last 5 minutes — the service exists but has no monitored signals (or was quiet). Health is unknown, not healthy.`
      : `Service "${args.service}" was not found in any connected source. Check the exact name via list_services. (Not reporting a health score for a service that does not exist.)`;
    const result: ServiceHealth = {
      service: args.service,
      status: "unknown",
      score: null,
      signals: { metrics: null, logs: null },
      anomalies,
      correlations,
      coverage,
      note,
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }

  // Calculate health score over the covered signals only.
  const { DEFAULT_HEALTH_THRESHOLDS } = await import("../config/loader.js");
  const health = calculateHealthScore({
    cpu,
    memory,
    errorRate,
    latencyP99,
    logErrorRate,
  }, _thresholds || DEFAULT_HEALTH_THRESHOLDS, coverage);

  const result: ServiceHealth = {
    service: args.service,
    status: health.status,
    score: health.score,
    signals: {
      metrics: metricsHadData ? { cpu, memory, errorRate, latencyP99 } : null,
      logs: logsHadData ? { errorRate: logErrorRate, topErrors } : null,
    },
    anomalies,
    correlations,
    coverage,
    note: !metricsHadData
      ? "No metrics signal for this service — score reflects logs only."
      : !logsHadData
        ? "No logs signal for this service — score reflects metrics only."
        : undefined,
  };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

/** Best-effort: does any connector in the tenant know this service name?
 *  Used only on the no-data path to distinguish "exists but unmonitored/quiet"
 *  from "doesn't exist (typo/decommissioned)". A connector that throws is
 *  treated as "can't confirm" and skipped. */
async function knownServiceNames(
  connectors: { listServices?: () => Promise<Array<{ name: string }>> }[],
  service: string,
): Promise<boolean> {
  for (const c of connectors) {
    if (!c.listServices) continue;
    try {
      const svcs = await c.listServices();
      if (svcs.some((s) => s.name === service)) return true;
    } catch {
      /* can't confirm via this connector — keep checking */
    }
  }
  return false;
}

function checkAnomaly(
  values: number[],
  metric: string,
  service: string,
  source: string,
  anomalies: AnomalyReport[]
) {
  // Robust, metric-type-aware detector (same path as detect_anomalies):
  // latency/error_rate/saturation are one-sided, so a *decrease* (e.g.
  // latency dropping) is correctly NOT flagged as an anomaly.
  const result = detectRobustAnomaly(values, { metricKind: classifyMetric(metric) });
  if (result.isAnomaly) {
    const deviationPercent = result.baselineValue === 0
      ? 100
      : Math.round(((result.recentValue - result.baselineValue) / result.baselineValue) * 100);
    anomalies.push({
      metric,
      severity: Math.abs(result.score) >= 6 ? "high" : Math.abs(result.score) >= 4 ? "medium" : "low",
      description: `${metric}: ${result.reason}`,
      currentValue: result.recentValue,
      baselineValue: result.baselineValue,
      deviationPercent,
      source,
      service,
    });
  }
}
