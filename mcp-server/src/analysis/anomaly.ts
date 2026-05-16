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

// ---------------------------------------------------------------------------
// Robust detection (median/MAD) — resistant to the trend & outliers that skew
// mean/stdDev. Adds warmup, dwell/hysteresis, a slow-ramp trend detector, and
// per-metric-type behaviour.
// ---------------------------------------------------------------------------

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Median Absolute Deviation, scaled to be a consistent estimator of stdDev. */
export function mad(values: number[], center?: number): number {
  if (values.length === 0) return 0;
  const med = center ?? median(values);
  const deviations = values.map((v) => Math.abs(v - med));
  return 1.4826 * median(deviations);
}

export type MetricKind = "latency" | "error_rate" | "saturation" | "throughput" | "generic";

export function classifyMetric(metric: string): MetricKind {
  const m = metric.toLowerCase();
  if (/(latency|duration|response_time|p\d{2,3})/.test(m)) return "latency";
  if (/(error|fail|5xx|4xx)/.test(m)) return "error_rate";
  if (/(cpu|mem|memory|heap|disk|saturat|util|queue|pool|fd|gc)/.test(m)) return "saturation";
  if (/(request_rate|rps|qps|throughput|traffic)/.test(m)) return "throughput";
  return "generic";
}

export interface RobustAnomalyOptions {
  /** Minimum samples before any detection (cold-start guard). */
  minSamples?: number;
  /** Number of trailing points evaluated as "recent". */
  recentWindow?: number;
  /** Robust-z threshold. */
  threshold?: number;
  /** Consecutive breaching recent points required to fire (dwell/hysteresis). */
  dwell?: number;
  metricKind?: MetricKind;
}

export interface RobustAnomalyResult {
  isAnomaly: boolean;
  /** Robust z = (median(recent) - median(baseline)) / MAD(baseline). */
  score: number;
  method: "robust-z" | "trend" | "none";
  direction: "above" | "below" | "flat";
  recentValue: number;
  baselineValue: number;
  reason: string;
}

const NONE: RobustAnomalyResult = {
  isAnomaly: false,
  score: 0,
  method: "none",
  direction: "flat",
  recentValue: 0,
  baselineValue: 0,
  reason: "insufficient data (warmup)",
};

/**
 * Robust anomaly detection.
 *
 * Unlike {@link detectRecentAnomaly}, the baseline is the *early stable* portion
 * of the series (it excludes the recent window AND the trailing ramp), so a slow
 * monotonic increase — e.g. a memory leak heading toward OOM — no longer poisons
 * its own baseline. Saturation/latency metrics additionally run a trend detector
 * that catches gradual ramps even when no single point is a spike.
 */
export function detectRobustAnomaly(
  values: number[],
  opts: RobustAnomalyOptions = {}
): RobustAnomalyResult {
  const minSamples = opts.minSamples ?? 15;
  const recentWindow = opts.recentWindow ?? 5;
  const threshold = opts.threshold ?? 3.0;
  const dwell = opts.dwell ?? 2;
  const kind = opts.metricKind ?? "generic";

  // Warmup guard.
  if (values.length < Math.max(minSamples, recentWindow * 3)) return { ...NONE };

  const recent = values.slice(-recentWindow);
  // Baseline = leading stable portion only; exclude the recent window and a
  // trailing margin so a ramp that ends in `recent` cannot inflate it.
  const baselineEnd = Math.max(
    Math.floor(values.length * 0.5),
    values.length - recentWindow * 3
  );
  const baseline = values.slice(0, baselineEnd);
  if (baseline.length < 3) return { ...NONE };

  const baseMed = median(baseline);
  const baseMad = mad(baseline, baseMed);
  const recentMed = median(recent);

  // One-sided metrics: a drop in error_rate / latency / saturation is good news.
  const oneSidedUp = kind === "error_rate" || kind === "latency" || kind === "saturation";

  // Robust z. Guard against MAD == 0 (perfectly flat baseline) with a tiny
  // relative epsilon so a real shift off a flat baseline still registers.
  const scale = baseMad > 0 ? baseMad : Math.max(Math.abs(baseMed) * 1e-3, 1e-9);
  const z = (recentMed - baseMed) / scale;
  const direction: RobustAnomalyResult["direction"] =
    z > 0 ? "above" : z < 0 ? "below" : "flat";

  // Dwell: require the last `dwell` points to each individually breach.
  const tail = values.slice(-dwell);
  const breaches = tail.filter((v) => {
    const pz = (v - baseMed) / scale;
    return oneSidedUp ? pz >= threshold : Math.abs(pz) >= threshold;
  });
  const dwellMet = breaches.length >= dwell;

  const zHit = (oneSidedUp ? z >= threshold : Math.abs(z) >= threshold) && dwellMet;

  // Trend detector for slow ramps (saturation/latency). Catches a sustained
  // monotonic climb even when the windowed robust-z is still sub-threshold.
  let trendHit = false;
  let trendReason = "";
  if (!zHit && (kind === "saturation" || kind === "latency") && values.length >= minSamples) {
    let ups = 0;
    for (let i = 1; i < values.length; i++) if (values[i] > values[i - 1]) ups++;
    const monotonicFrac = ups / (values.length - 1);
    const netRise = (recentMed - baseMed) / scale;
    if (monotonicFrac >= 0.7 && netRise >= 2.0) {
      trendHit = true;
      trendReason = `sustained upward trend: ${Math.round(monotonicFrac * 100)}% of steps rising, +${netRise.toFixed(1)} robust-σ net`;
    }
  }

  if (zHit) {
    return {
      isAnomaly: true,
      score: z,
      method: "robust-z",
      direction,
      recentValue: recentMed,
      baselineValue: baseMed,
      reason: `recent median ${recentMed.toFixed(2)} is ${z.toFixed(1)} robust-σ ${direction} baseline ${baseMed.toFixed(2)} (dwell ${breaches.length}/${dwell})`,
    };
  }
  if (trendHit) {
    return {
      isAnomaly: true,
      score: (recentMed - baseMed) / scale,
      method: "trend",
      direction: "above",
      recentValue: recentMed,
      baselineValue: baseMed,
      reason: trendReason,
    };
  }
  return {
    isAnomaly: false,
    score: z,
    method: "none",
    direction,
    recentValue: recentMed,
    baselineValue: baseMed,
    reason: "within robust baseline",
  };
}

// ---------------------------------------------------------------------------
// Seasonality-aware baseline (A2) — compares the recent window against the
// SAME time-of-day phase in prior periods, not against the immediately
// preceding values. A nightly traffic trough or a daily batch-job spike is
// then "expected", not an anomaly; a real regression still stands out because
// it deviates from its own historical same-phase distribution.
// ---------------------------------------------------------------------------

export interface SeasonalPoint {
  /** Unix epoch milliseconds, or an ISO-8601 timestamp string. */
  timestamp: number | string;
  value: number;
}

export interface SeasonalAnomalyOptions {
  /** Season length in seconds. Default: 86400 (daily / time-of-day). */
  periodSeconds?: number;
  /** Phase tolerance in seconds — how close in-phase a historical sample
   *  must be to count toward the baseline. Default: periodSeconds / 48
   *  (≈30 min for a daily period). */
  phaseToleranceSeconds?: number;
  /** Trailing points treated as "recent". Default: 5. */
  recentWindow?: number;
  /** Robust-z threshold against the same-phase distribution. Default: 3.5. */
  threshold?: number;
  /** Minimum same-phase historical samples required to trust the baseline. */
  minPhaseSamples?: number;
  metricKind?: MetricKind;
}

export interface SeasonalAnomalyResult {
  isAnomaly: boolean;
  /** false when there is not enough multi-period history — caller should
   *  fall back to {@link detectRobustAnomaly}. */
  applicable: boolean;
  score: number;
  expected: number;
  recentValue: number;
  direction: "above" | "below" | "flat";
  phaseSamples: number;
  reason: string;
}

function toEpochSeconds(t: number | string): number {
  if (typeof t === "number") return t > 1e12 ? t / 1000 : t;
  return new Date(t).getTime() / 1000;
}

/**
 * Seasonal-naive detection: predict the recent value from the robust
 * (median/MAD) distribution of historical points at the same phase of the
 * season, and flag a deviation. Falls back (applicable=false) when the series
 * does not span enough periods to build a same-phase baseline.
 */
export function detectSeasonalAnomaly(
  points: SeasonalPoint[],
  opts: SeasonalAnomalyOptions = {}
): SeasonalAnomalyResult {
  const period = opts.periodSeconds ?? 86400;
  const tol = opts.phaseToleranceSeconds ?? period / 48;
  const recentWindow = opts.recentWindow ?? 5;
  const threshold = opts.threshold ?? 3.5;
  const minPhaseSamples = opts.minPhaseSamples ?? 4;
  const kind = opts.metricKind ?? "generic";

  const NA: SeasonalAnomalyResult = {
    isAnomaly: false,
    applicable: false,
    score: 0,
    expected: 0,
    recentValue: 0,
    direction: "flat",
    phaseSamples: 0,
    reason: "insufficient multi-period history",
  };

  if (points.length < recentWindow + 2) return NA;

  const series = points
    .map((p) => ({ t: toEpochSeconds(p.timestamp), v: p.value }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
  if (series.length < recentWindow + 2) return NA;

  const span = series[series.length - 1].t - series[0].t;
  // Need at least ~2 full periods of history to have any same-phase samples.
  if (span < period * 2) return NA;

  const recent = series.slice(-recentWindow);
  const history = series.slice(0, -recentWindow);
  const recentPhase = ((recent[recent.length - 1].t % period) + period) % period;

  // Same-phase historical samples: phase distance within tolerance (wrapping).
  const samePhase = history
    .filter((p) => {
      const ph = ((p.t % period) + period) % period;
      const d = Math.abs(ph - recentPhase);
      return Math.min(d, period - d) <= tol;
    })
    .map((p) => p.v);

  if (samePhase.length < minPhaseSamples) return NA;

  const expected = median(samePhase);
  const spread = mad(samePhase, expected);
  const recentMed = median(recent.map((p) => p.v));
  const scale = spread > 0 ? spread : Math.max(Math.abs(expected) * 1e-3, 1e-9);
  const z = (recentMed - expected) / scale;
  const direction: SeasonalAnomalyResult["direction"] =
    z > 0 ? "above" : z < 0 ? "below" : "flat";

  const oneSidedUp = kind === "error_rate" || kind === "latency" || kind === "saturation";
  const hit = oneSidedUp ? z >= threshold : Math.abs(z) >= threshold;

  return {
    isAnomaly: hit,
    applicable: true,
    score: z,
    expected,
    recentValue: recentMed,
    direction,
    phaseSamples: samePhase.length,
    reason: hit
      ? `recent ${recentMed.toFixed(2)} is ${z.toFixed(1)} robust-σ ${direction} the seasonal baseline ${expected.toFixed(2)} (n=${samePhase.length} same-phase samples)`
      : `within seasonal baseline (${expected.toFixed(2)}, n=${samePhase.length})`,
  };
}

/**
 * Orchestrator: prefer the seasonality-aware baseline when the series spans
 * enough periods to build a same-phase distribution; otherwise fall back to
 * the robust windowed detector. Returns a normalized verdict.
 */
export function detectAnomaly(
  points: SeasonalPoint[],
  opts: SeasonalAnomalyOptions & RobustAnomalyOptions = {}
): {
  isAnomaly: boolean;
  method: "seasonal" | "robust-z" | "trend" | "none";
  score: number;
  recentValue: number;
  baselineValue: number;
  direction: "above" | "below" | "flat";
  reason: string;
} {
  const seasonal = detectSeasonalAnomaly(points, opts);
  if (seasonal.applicable) {
    return {
      isAnomaly: seasonal.isAnomaly,
      method: "seasonal",
      score: seasonal.score,
      recentValue: seasonal.recentValue,
      baselineValue: seasonal.expected,
      direction: seasonal.direction,
      reason: seasonal.reason,
    };
  }
  const r = detectRobustAnomaly(points.map((p) => p.value), opts);
  return {
    isAnomaly: r.isAnomaly,
    method: r.method,
    score: r.score,
    recentValue: r.recentValue,
    baselineValue: r.baselineValue,
    direction: r.direction,
    reason: r.reason,
  };
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
