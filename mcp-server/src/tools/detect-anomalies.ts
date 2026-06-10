import type { ConnectorRegistry } from "../connectors/registry.js";
import { defaultContext, type RequestContext } from "../context.js";
import type { AnomalyReport } from "../types.js";
import { detectAnomaly, classifyMetric } from "../analysis/anomaly.js";
import { rankRootCause } from "../analysis/correlator.js";

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

const KEY_METRICS = ["cpu", "memory", "error_rate", "latency_p99", "request_rate"];

// Patterns that signal a serious incident even at warn level and even when
// the overall error ratio is low (e.g. a memory leak emits a handful of
// "OutOfMemoryWarning" lines long before it turns into 5xx errors).
const CRITICAL_LOG_PATTERN =
  /\b(out\s?of\s?memory|oom|outofmemory|heap (usage|exhaust)|memory leak|panic|fatal|deadlock|segfault|stack overflow|cannot allocate)\b/i;

// Optional dependency. When provided, every metric-derived anomaly
// score is mirrored to the TSDB sink so `get_anomaly_history` can
// replay it later. Wiring this lives at the call site in index.ts
// — keeping the handler pure-injectable means unit tests don't need
// a fake sink.
export interface AnomalyHistorySink {
  record(entry: {
    ts: string;
    service: string;
    tenant: string;
    score: number;
    method: string;
    severity: string;
    signal?: string;
  }): Promise<void> | void;
}

export async function detectAnomaliesHandler(
  registry: ConnectorRegistry,
  args: { service?: string; duration?: string; sensitivity?: string },
  ctx: RequestContext = defaultContext(),
  history?: AnomalyHistorySink
) {
  const duration = args.duration || "10m";
  const threshold = SENSITIVITY_THRESHOLDS[args.sensitivity || "medium"] || 2.0;

  // Discover services to scan — tenant-scoped.
  const tenantConnectors = registry.getByTenant(ctx.tenant);
  const metricsConnectors = tenantConnectors.filter((c) => c.signalType === "metrics");
  const logConnectors = tenantConnectors.filter((c) => c.signalType === "logs");

  // Discover services from BOTH metrics and log connectors, tracking which
  // signal each service exposes. Previously the fleet scan only enumerated
  // metrics connectors, so a log-only service was silently dropped from the
  // scan — and the "all healthy" all-clear never said so (issue #453B). Now
  // log-only services are scanned (via their log error-rate, as the
  // description promises) and the per-service coverage is reported.
  const coverage = new Map<string, { metrics: boolean; logs: boolean }>();
  const mark = (name: string, key: "metrics" | "logs") => {
    const e = coverage.get(name) ?? { metrics: false, logs: false };
    e[key] = true;
    coverage.set(name, e);
  };
  for (const connector of metricsConnectors) {
    try { for (const s of await connector.listServices()) mark(s.name, "metrics"); } catch { /* connector down — skip */ }
  }
  for (const connector of logConnectors) {
    try { for (const s of await connector.listServices()) mark(s.name, "logs"); } catch { /* connector down — skip */ }
  }

  let serviceNames: string[];
  if (args.service) {
    serviceNames = [args.service];
    if (!coverage.has(args.service)) {
      // Unknown to listServices — still attempt both signal paths.
      coverage.set(args.service, { metrics: metricsConnectors.length > 0, logs: logConnectors.length > 0 });
    }
  } else {
    serviceNames = [...coverage.keys()];
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
          const points = result.values.map((v) => ({ timestamp: v.timestamp, value: v.value }));
          const anomaly = detectAnomaly(points, {
            threshold,
            metricKind: classifyMetric(metric),
          });

          if (anomaly.isAnomaly) {
            const deviationPercent = anomaly.baselineValue === 0
              ? 100
              : Math.round(((anomaly.recentValue - anomaly.baselineValue) / anomaly.baselineValue) * 100);
            const severityLabel = Math.abs(anomaly.score) >= 6 ? "high" : Math.abs(anomaly.score) >= 4 ? "medium" : "low";
            allAnomalies.push({
              metric,
              severity: severityLabel,
              description: `${metric}: ${anomaly.reason}`,
              currentValue: anomaly.recentValue,
              baselineValue: anomaly.baselineValue,
              deviationPercent,
              source: connector.name,
              service: serviceName,
            });
            // Phase P1: mirror the score to the TSDB sink (no-op if no
            // sink wired). Best-effort — a slow / down sink must never
            // block the detector loop, which is why we don't await.
            if (history) {
              try {
                void history.record({
                  ts: new Date().toISOString(),
                  service: serviceName,
                  tenant: ctx.tenant || "default",
                  score: Math.abs(anomaly.score),
                  method: anomaly.method === "seasonal" ? "seasonality"
                        : anomaly.method === "robust-z" ? "mad"
                        : anomaly.method,
                  severity: severityLabel === "high" ? "critical" : severityLabel === "medium" ? "warn" : "info",
                  signal: metric,
                });
              } catch { /* swallow — best-effort */ }
            }
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

        // Critical-pattern scan — independent of the error-ratio gate, so a
        // warn-level OOM/leak signal is not silently dropped.
        const criticalPattern = logs.summary.topPatterns.find((p) =>
          CRITICAL_LOG_PATTERN.test(p)
        );
        if (criticalPattern) {
          allAnomalies.push({
            metric: "log_critical_pattern",
            severity: "high",
            description: `Critical log pattern detected: "${criticalPattern}"`,
            currentValue: logs.summary.errorCount + logs.summary.warnCount,
            baselineValue: 0,
            deviationPercent: 100,
            source: connector.name,
            service: serviceName,
          });
        }

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

  // Dependency-aware root-cause ranking. The service graph / change markers
  // are empty here (no trace source wired yet); ranking then degrades to
  // severity-weighted ordering and still names the most likely culprit
  // instead of just listing "both signals bad".
  const rootCause =
    allAnomalies.length > 0
      ? rankRootCause(
          allAnomalies.map((a) => ({
            service: a.service,
            metric: a.metric,
            severity: a.severity,
          }))
        )
      : { ranked: [], summary: "" };

  // Per-service coverage so an "all healthy" all-clear is verifiable rather
  // than silently partial: the caller sees exactly which services were
  // scanned and on which signals (issue #453B).
  const scanned = serviceNames.map((name) => {
    const cov = coverage.get(name) ?? { metrics: false, logs: false };
    const signals = [cov.metrics ? "metrics" : null, cov.logs ? "logs" : null].filter(Boolean) as string[];
    return { service: name, signals };
  });
  const metricsCount = scanned.filter((s) => s.signals.includes("metrics")).length;
  const logsCount = scanned.filter((s) => s.signals.includes("logs")).length;

  const result = {
    scannedServices: serviceNames.length,
    coverage: { scanned },
    anomalies: allAnomalies,
    correlations: allCorrelations,
    rootCause,
    summary:
      allAnomalies.length === 0
        ? `No anomalies across ${serviceNames.length} scanned service(s) (${metricsCount} with metrics, ${logsCount} with logs).`
        : `${allAnomalies.length} anomal${allAnomalies.length === 1 ? "y" : "ies"} detected across ${[...new Set(allAnomalies.map((a) => a.service))].length} of ${serviceNames.length} scanned service(s).`,
  };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}
