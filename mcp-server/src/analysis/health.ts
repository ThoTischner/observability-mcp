import type { HealthStatus, HealthThresholds } from "../types.js";

export interface HealthInputs {
  cpu: number;
  memory: number;
  errorRate: number;
  latencyP99: number;
  logErrorRate: number;
}

export interface HealthResult {
  /** 0-100, or null when no signal had data (status "unknown"). */
  score: number | null;
  status: HealthStatus | "unknown";
  details: Record<string, { score: number; value: number; threshold: string }>;
}

/** Which signal families actually returned data. Missing/false families are
 *  excluded from the weighted score and the remaining weights are
 *  renormalised — so a log-only service is judged on its logs, not on metric
 *  zeros coerced to "healthy" (issue #453). Omit for the back-compat
 *  all-signals-present behaviour. */
export interface SignalCoverage {
  metrics?: boolean;
  logs?: boolean;
}

export function calculateHealthScore(
  inputs: HealthInputs,
  thresholds: HealthThresholds,
  coverage?: SignalCoverage,
): HealthResult {
  const w = thresholds.weights;
  const t = thresholds;
  const hasMetrics = coverage?.metrics !== false; // default: present (back-compat)
  const hasLogs = coverage?.logs !== false;

  const cpuScore = scoreFromThreshold(inputs.cpu, t.cpu.good, t.cpu.warn, t.cpu.crit);
  const errorRateScore = scoreFromThreshold(inputs.errorRate, t.errorRate.good, t.errorRate.warn, t.errorRate.crit);
  const latencyScore = scoreFromThreshold(inputs.latencyP99, t.latencyP99.good, t.latencyP99.warn, t.latencyP99.crit);
  const logErrorScore = scoreFromThreshold(inputs.logErrorRate, t.logErrors.good, t.logErrors.warn, t.logErrors.crit);

  // Only count the families that actually reported data; renormalise by the
  // sum of their weights so a missing family is neither a free "100" nor a
  // free "0". With full coverage the active weights sum to ~1 and this equals
  // the previous behaviour.
  let weighted = 0;
  let activeWeight = 0;
  if (hasMetrics) {
    weighted += cpuScore * w.cpu + errorRateScore * w.errorRate + latencyScore * w.latency;
    activeWeight += w.cpu + w.errorRate + w.latency;
  }
  if (hasLogs) {
    weighted += logErrorScore * w.logErrors;
    activeWeight += w.logErrors;
  }

  const details: HealthResult["details"] = {};
  if (hasMetrics) {
    details.cpu = { score: Math.round(cpuScore), value: inputs.cpu, threshold: `warn >${t.cpu.warn}%, crit >${t.cpu.crit}%` };
    details.errorRate = { score: Math.round(errorRateScore), value: inputs.errorRate, threshold: `warn >${t.errorRate.warn}/s, crit >${t.errorRate.crit}/s` };
    details.latencyP99 = { score: Math.round(latencyScore), value: inputs.latencyP99, threshold: `warn >${t.latencyP99.warn}s, crit >${t.latencyP99.crit}s` };
  }
  if (hasLogs) {
    details.logErrors = { score: Math.round(logErrorScore), value: inputs.logErrorRate, threshold: `warn >${t.logErrors.warn}/min, crit >${t.logErrors.crit}/min` };
  }

  // No family reported data → honestly unknown, not a confident 100/healthy.
  if (activeWeight === 0) {
    return { score: null, status: "unknown", details };
  }

  const score = Math.round(Math.max(0, Math.min(100, weighted / activeWeight)));
  const status: HealthStatus =
    score > t.statusBoundaries.healthy ? "healthy" :
    score > t.statusBoundaries.degraded ? "degraded" : "critical";

  return { score, status, details };
}

function scoreFromThreshold(value: number, good: number, warn: number, crit: number): number {
  if (value <= good) return 100;
  if (value <= warn) return 100 - ((value - good) / (warn - good)) * 40;
  if (value <= crit) return 60 - ((value - warn) / (crit - warn)) * 40;
  return Math.max(0, 20 - ((value - crit) / crit) * 20);
}
