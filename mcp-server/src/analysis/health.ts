import type { HealthStatus, HealthThresholds } from "../types.js";

interface HealthInputs {
  cpu: number;
  memory: number;
  errorRate: number;
  latencyP99: number;
  logErrorRate: number;
}

interface HealthResult {
  score: number;
  status: HealthStatus;
  details: Record<string, { score: number; value: number; threshold: string }>;
}

export function calculateHealthScore(inputs: HealthInputs, thresholds: HealthThresholds): HealthResult {
  const w = thresholds.weights;
  const t = thresholds;

  const cpuScore = scoreFromThreshold(inputs.cpu, t.cpu.good, t.cpu.warn, t.cpu.crit);
  const errorRateScore = scoreFromThreshold(inputs.errorRate, t.errorRate.good, t.errorRate.warn, t.errorRate.crit);
  const latencyScore = scoreFromThreshold(inputs.latencyP99, t.latencyP99.good, t.latencyP99.warn, t.latencyP99.crit);
  const logErrorScore = scoreFromThreshold(inputs.logErrorRate, t.logErrors.good, t.logErrors.warn, t.logErrors.crit);

  const weightedScore =
    cpuScore * w.cpu +
    errorRateScore * w.errorRate +
    latencyScore * w.latency +
    logErrorScore * w.logErrors;

  const score = Math.round(Math.max(0, Math.min(100, weightedScore)));
  const status: HealthStatus =
    score > t.statusBoundaries.healthy ? "healthy" :
    score > t.statusBoundaries.degraded ? "degraded" : "critical";

  return {
    score,
    status,
    details: {
      cpu: { score: Math.round(cpuScore), value: inputs.cpu, threshold: `warn >${t.cpu.warn}%, crit >${t.cpu.crit}%` },
      errorRate: { score: Math.round(errorRateScore), value: inputs.errorRate, threshold: `warn >${t.errorRate.warn}/s, crit >${t.errorRate.crit}/s` },
      latencyP99: { score: Math.round(latencyScore), value: inputs.latencyP99, threshold: `warn >${t.latencyP99.warn}s, crit >${t.latencyP99.crit}s` },
      logErrors: { score: Math.round(logErrorScore), value: inputs.logErrorRate, threshold: `warn >${t.logErrors.warn}/min, crit >${t.logErrors.crit}/min` },
    },
  };
}

function scoreFromThreshold(value: number, good: number, warn: number, crit: number): number {
  if (value <= good) return 100;
  if (value <= warn) return 100 - ((value - good) / (warn - good)) * 40;
  if (value <= crit) return 60 - ((value - warn) / (crit - warn)) * 40;
  return Math.max(0, 20 - ((value - crit) / crit) * 20);
}
