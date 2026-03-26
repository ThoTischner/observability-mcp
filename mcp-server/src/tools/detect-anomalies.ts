import type { ConnectorRegistry } from "../connectors/registry.js";
import type { AnomalyReport } from "../types.js";
import { detectRecentAnomaly } from "../analysis/anomaly.js";
import { correlateSignals } from "../analysis/correlator.js";

export const detectAnomaliesDefinition = {
  name: "detect_anomalies" as const,
  description:
    "Scan for anomalies across all monitored services (or a specific service). Detects metric deviations using z-score analysis against recent baseline, checks log error spikes, and correlates signals across metrics and logs. Returns anomalies with severity ratings and cross-signal correlations.",
  inputSchema: {
    type: "object" as const,
    properties: {
      service: {
        type: "string",
        description: "Specific service to scan. If omitted, scans all services.",
      },
      duration: {
        type: "string",
        description: "Time range to analyze (e.g. '5m', '15m', '1h'). Default: '10m'",
      },
      sensitivity: {
        type: "string",
        enum: ["low", "medium", "high"],
        description:
          "Detection sensitivity. 'low' = major deviations only (>3σ), 'medium' = moderate (>2σ), 'high' = subtle changes (>1.5σ). Default: 'medium'",
      },
    },
  },
};

const SENSITIVITY_THRESHOLDS: Record<string, number> = {
  low: 3.0,
  medium: 2.0,
  high: 1.5,
};

const KEY_METRICS = ["cpu", "error_rate", "latency_p99", "request_rate"];

export async function detectAnomaliesHandler(
  registry: ConnectorRegistry,
  args: { service?: string; duration?: string; sensitivity?: string }
) {
  const duration = args.duration || "10m";
  const threshold = SENSITIVITY_THRESHOLDS[args.sensitivity || "medium"] || 2.0;

  // Discover services to scan
  const metricsConnectors = registry.getBySignal("metrics");
  const logConnectors = registry.getBySignal("logs");

  let serviceNames: string[] = [];
  if (args.service) {
    serviceNames = [args.service];
  } else {
    for (const connector of metricsConnectors) {
      const services = await connector.listServices();
      for (const s of services) {
        if (!serviceNames.includes(s.name)) serviceNames.push(s.name);
      }
    }
  }

  const allAnomalies: AnomalyReport[] = [];
  const allCorrelations: string[] = [];

  for (const serviceName of serviceNames) {
    // Check metrics
    for (const connector of metricsConnectors) {
      if (!connector.queryMetrics) continue;

      for (const metric of KEY_METRICS) {
        try {
          const result = await connector.queryMetrics({ service: serviceName, metric, duration });
          const values = result.values.map((v) => v.value);
          const anomaly = detectRecentAnomaly(values, 5, threshold);

          if (anomaly.isAnomaly) {
            const deviationPercent = anomaly.baselineAvg === 0
              ? 100
              : Math.round(((anomaly.recentAvg - anomaly.baselineAvg) / anomaly.baselineAvg) * 100);
            allAnomalies.push({
              metric,
              severity: Math.abs(anomaly.zScore) >= 3 ? "high" : Math.abs(anomaly.zScore) >= 2 ? "medium" : "low",
              description: `${metric} is ${anomaly.zScore.toFixed(1)}σ ${anomaly.zScore > 0 ? "above" : "below"} baseline (${anomaly.baselineAvg.toFixed(2)} → ${anomaly.recentAvg.toFixed(2)})`,
              currentValue: anomaly.recentAvg,
              baselineValue: anomaly.baselineAvg,
              deviationPercent,
              source: connector.name,
              service: serviceName,
            });
          }
        } catch {
          // Skip metrics that don't exist for this service
        }
      }
    }

    // Check logs for error spikes
    for (const connector of logConnectors) {
      if (!connector.queryLogs) continue;
      try {
        const logs = await connector.queryLogs({ service: serviceName, duration, limit: 500 });
        if (logs.summary.errorCount > 5) {
          const errorRatio = logs.summary.total > 0
            ? logs.summary.errorCount / logs.summary.total
            : 0;
          if (errorRatio > 0.1) {
            allAnomalies.push({
              metric: "log_error_rate",
              severity: errorRatio > 0.3 ? "high" : errorRatio > 0.15 ? "medium" : "low",
              description: `${Math.round(errorRatio * 100)}% of logs are errors (${logs.summary.errorCount}/${logs.summary.total}). Top: ${logs.summary.topPatterns[0] || "N/A"}`,
              currentValue: logs.summary.errorCount,
              baselineValue: 0,
              deviationPercent: 100,
              source: connector.name,
              service: serviceName,
            });
          }
        }
      } catch {
        // Skip if logs unavailable
      }
    }
  }

  // Cross-signal correlation
  if (allAnomalies.length > 0) {
    const servicesWithAnomalies = [...new Set(allAnomalies.map((a) => a.service))];
    for (const svc of servicesWithAnomalies) {
      const svcAnomalies = allAnomalies.filter((a) => a.service === svc);
      const metricTypes = svcAnomalies.map((a) => a.metric).filter((m) => m !== "log_error_rate");
      const hasLogAnomaly = svcAnomalies.some((a) => a.metric === "log_error_rate");

      if (metricTypes.length > 0 && hasLogAnomaly) {
        allCorrelations.push(
          `${svc}: metric anomalies (${metricTypes.join(", ")}) correlate with elevated log error rate`
        );
      }
      if (metricTypes.includes("cpu") && metricTypes.includes("latency_p99")) {
        allCorrelations.push(
          `${svc}: CPU spike and latency increase detected simultaneously — possible resource saturation`
        );
      }
    }
  }

  const result = {
    scannedServices: serviceNames.length,
    anomalies: allAnomalies,
    correlations: allCorrelations,
    summary:
      allAnomalies.length === 0
        ? "All services healthy — no anomalies detected."
        : `${allAnomalies.length} anomal${allAnomalies.length === 1 ? "y" : "ies"} detected across ${[...new Set(allAnomalies.map((a) => a.service))].length} service(s).`,
  };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}
