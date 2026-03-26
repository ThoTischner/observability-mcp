import type { ConnectorRegistry } from "../connectors/registry.js";
import type { ServiceHealth, AnomalyReport, HealthThresholds } from "../types.js";
import { calculateHealthScore } from "../analysis/health.js";
import { detectRecentAnomaly } from "../analysis/anomaly.js";

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
  args: { service: string }
) {
  const metricsConnectors = registry.getBySignal("metrics");
  const logConnectors = registry.getBySignal("logs");

  // Gather metrics
  let cpu = 0, memory = 0, errorRate = 0, latencyP99 = 0;
  const anomalies: AnomalyReport[] = [];

  for (const connector of metricsConnectors) {
    if (!connector.queryMetrics) continue;
    try {
      const cpuResult = await connector.queryMetrics({ service: args.service, metric: "cpu", duration: "5m" });
      cpu = cpuResult.summary.current;
      checkAnomaly(cpuResult.values.map(v => v.value), "cpu", args.service, connector.name, anomalies);

      const memResult = await connector.queryMetrics({ service: args.service, metric: "memory", duration: "5m" });
      memory = memResult.summary.current / 1_000_000; // Convert to MB for display

      const errResult = await connector.queryMetrics({ service: args.service, metric: "error_rate", duration: "5m" });
      errorRate = errResult.summary.current;
      checkAnomaly(errResult.values.map(v => v.value), "error_rate", args.service, connector.name, anomalies);

      const latResult = await connector.queryMetrics({ service: args.service, metric: "latency_p99", duration: "5m" });
      latencyP99 = latResult.summary.current;
      checkAnomaly(latResult.values.map(v => v.value), "latency_p99", args.service, connector.name, anomalies);
    } catch (err) {
      console.error(`Health check metrics failed for ${args.service}:`, err);
    }
  }

  // Gather logs
  let logErrorRate = 0;
  let topErrors: string[] = [];
  const correlations: string[] = [];

  for (const connector of logConnectors) {
    if (!connector.queryLogs) continue;
    try {
      const logs = await connector.queryLogs({ service: args.service, duration: "5m", limit: 200 });
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
      console.error(`Health check logs failed for ${args.service}:`, err);
    }
  }

  // Calculate health score
  const { DEFAULT_HEALTH_THRESHOLDS } = await import("../config/loader.js");
  const health = calculateHealthScore({
    cpu,
    memory,
    errorRate,
    latencyP99,
    logErrorRate,
  }, _thresholds || DEFAULT_HEALTH_THRESHOLDS);

  const result: ServiceHealth = {
    service: args.service,
    status: health.status,
    score: health.score,
    signals: {
      metrics: { cpu, memory, errorRate, latencyP99 },
      logs: { errorRate: logErrorRate, topErrors },
    },
    anomalies,
    correlations,
  };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

function checkAnomaly(
  values: number[],
  metric: string,
  service: string,
  source: string,
  anomalies: AnomalyReport[]
) {
  const result = detectRecentAnomaly(values);
  if (result.isAnomaly) {
    const deviationPercent = result.baselineAvg === 0
      ? 100
      : Math.round(((result.recentAvg - result.baselineAvg) / result.baselineAvg) * 100);
    anomalies.push({
      metric,
      severity: Math.abs(result.zScore) >= 3 ? "high" : Math.abs(result.zScore) >= 2 ? "medium" : "low",
      description: `${metric} is ${result.zScore.toFixed(1)}σ ${result.zScore > 0 ? "above" : "below"} baseline (${result.baselineAvg.toFixed(2)} → ${result.recentAvg.toFixed(2)})`,
      currentValue: result.recentAvg,
      baselineValue: result.baselineAvg,
      deviationPercent,
      source,
      service,
    });
  }
}
