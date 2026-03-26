import type { AnomalySeverity } from "../types.js";

export interface ZScoreResult {
  mean: number;
  stdDev: number;
  zScores: number[];
}

export function calculateZScore(values: number[]): ZScoreResult {
  if (values.length === 0) return { mean: 0, stdDev: 0, zScores: [] };

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);

  const zScores = stdDev === 0
    ? values.map(() => 0)
    : values.map((v) => (v - mean) / stdDev);

  return { mean, stdDev, zScores };
}

export interface AnomalyPoint {
  index: number;
  value: number;
  zScore: number;
  severity: AnomalySeverity;
}

export function detectAnomalyPoints(
  values: number[],
  threshold: number = 2.0
): AnomalyPoint[] {
  const { mean, stdDev, zScores } = calculateZScore(values);
  if (stdDev === 0) return [];

  const anomalies: AnomalyPoint[] = [];
  for (let i = 0; i < values.length; i++) {
    const absZ = Math.abs(zScores[i]);
    if (absZ >= threshold) {
      anomalies.push({
        index: i,
        value: values[i],
        zScore: zScores[i],
        severity: absZ >= 3 ? "high" : absZ >= 2 ? "medium" : "low",
      });
    }
  }
  return anomalies;
}

/**
 * Check if the most recent values deviate significantly from the baseline.
 * Compares the last `recentWindow` values against the rest.
 */
export function detectRecentAnomaly(
  values: number[],
  recentWindow: number = 5,
  threshold: number = 2.0
): { isAnomaly: boolean; zScore: number; recentAvg: number; baselineAvg: number } {
  if (values.length < recentWindow + 5) {
    return { isAnomaly: false, zScore: 0, recentAvg: 0, baselineAvg: 0 };
  }

  const baseline = values.slice(0, -recentWindow);
  const recent = values.slice(-recentWindow);

  const baselineAvg = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  const baselineStdDev = Math.sqrt(
    baseline.reduce((sum, v) => sum + (v - baselineAvg) ** 2, 0) / baseline.length
  );
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;

  const zScore = baselineStdDev === 0 ? 0 : (recentAvg - baselineAvg) / baselineStdDev;

  return {
    isAnomaly: Math.abs(zScore) >= threshold,
    zScore,
    recentAvg,
    baselineAvg,
  };
}
