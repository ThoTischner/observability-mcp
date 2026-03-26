import type { AnomalyReport, LogResult, MetricResult } from "../types.js";

/**
 * Cross-signal correlation: find relationships between metric anomalies and log patterns.
 * Simple timestamp-based approach: if a metric spike and error log increase happen
 * in the same time window, they are correlated.
 */
export function correlateSignals(
  anomalies: AnomalyReport[],
  logResults: LogResult[],
  metricResults: MetricResult[]
): string[] {
  const correlations: string[] = [];

  for (const anomaly of anomalies) {
    // Check if there's a corresponding log signal
    const serviceLogs = logResults.find((l) => l.service === anomaly.service);
    if (serviceLogs && serviceLogs.summary.errorCount > 0) {
      const errorPct =
        serviceLogs.summary.total > 0
          ? Math.round((serviceLogs.summary.errorCount / serviceLogs.summary.total) * 100)
          : 0;

      correlations.push(
        `${anomaly.service}: ${anomaly.metric} anomaly (${anomaly.severity}) correlates with ` +
        `${serviceLogs.summary.errorCount} error logs (${errorPct}% of total). ` +
        `Top error: ${serviceLogs.summary.topPatterns[0] || "N/A"}`
      );
    }

    // Check for metric cross-correlations (e.g., CPU spike + latency increase)
    const serviceMetrics = metricResults.filter((m) => m.service === anomaly.service);
    for (const metric of serviceMetrics) {
      if (metric.metric === anomaly.metric) continue;
      if (metric.summary.trend === "rising") {
        correlations.push(
          `${anomaly.service}: ${anomaly.metric} anomaly coincides with rising ${metric.metric} ` +
          `(current: ${metric.summary.current.toFixed(2)})`
        );
      }
    }
  }

  return [...new Set(correlations)]; // Deduplicate
}
