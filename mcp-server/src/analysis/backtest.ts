// ---------------------------------------------------------------------------
// Backtesting harness — a labelled synthetic suite + scorer for the anomaly
// engine. Each case carries ground truth (anomalous or not); the harness runs
// the production detector over it and computes a confusion matrix →
// precision / recall / F1. backtest.test.ts asserts a quality bar so a
// detector regression fails CI, and the published numbers in the README are
// regenerated from exactly this suite (they cannot silently drift).
// ---------------------------------------------------------------------------

import {
  detectAnomaly,
  type MetricKind,
  type SeasonalPoint,
} from "./anomaly.js";

/** Deterministic LCG so the suite is byte-stable across runs and CI. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export interface BacktestCase {
  name: string;
  /** Regime label for the per-category breakdown. */
  category: string;
  points: SeasonalPoint[];
  metricKind: MetricKind;
  /** Ground truth. */
  anomalous: boolean;
}

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);
const ts = (i: number, stepMs = 60_000) => T0 + i * stepMs;

function series(values: number[], stepMs = 60_000): SeasonalPoint[] {
  return values.map((v, i) => ({ timestamp: ts(i, stepMs), value: v }));
}

/**
 * Build the labelled suite. Multiple seeded variants per regime so the
 * precision/recall figures are stable rather than hostage to one sample.
 */
export function buildSuite(): BacktestCase[] {
  const cases: BacktestCase[] = [];

  for (let v = 0; v < 6; v++) {
    const r = rng(1000 + v);
    const noise = (amp: number) => (r() - 0.5) * 2 * amp;

    // --- POSITIVES -------------------------------------------------------
    // Slow memory-leak ramp toward OOM (the production false-negative).
    cases.push({
      name: `mem-leak-ramp#${v}`,
      category: "slow-ramp",
      points: series(Array.from({ length: 40 }, (_, i) => 120 + i * 7 + noise(4)), HOUR / 6),
      metricKind: "saturation",
      anomalous: true,
    });
    // Hard latency spike sustained over the recent window.
    cases.push({
      name: `latency-spike#${v}`,
      category: "spike",
      points: series([
        ...Array.from({ length: 25 }, () => 50 + noise(3)),
        ...Array.from({ length: 6 }, () => 480 + noise(20)),
      ]),
      metricKind: "latency",
      anomalous: true,
    });
    // Error-rate step jump.
    cases.push({
      name: `error-step#${v}`,
      category: "step",
      points: series([
        ...Array.from({ length: 25 }, () => 1 + Math.abs(noise(0.5))),
        ...Array.from({ length: 6 }, () => 40 + noise(3)),
      ]),
      metricKind: "error_rate",
      anomalous: true,
    });
    // Gradual latency creep (no single spike point).
    cases.push({
      name: `latency-creep#${v}`,
      category: "slow-ramp",
      points: series(Array.from({ length: 36 }, (_, i) => 60 + i * 5 + noise(3)), HOUR / 6),
      metricKind: "latency",
      anomalous: true,
    });

    // --- NEGATIVES -------------------------------------------------------
    // Stable noisy traffic.
    cases.push({
      name: `stable-noisy#${v}`,
      category: "stable",
      points: series(Array.from({ length: 40 }, () => 100 + noise(6))),
      metricKind: "generic",
      anomalous: false,
    });
    // Single transient blip — dwell/hysteresis must suppress it.
    cases.push({
      name: `transient-blip#${v}`,
      category: "transient",
      points: series([
        ...Array.from({ length: 34 }, () => 50 + noise(3)),
        520,
        ...Array.from({ length: 3 }, () => 50 + noise(3)),
      ]),
      metricKind: "latency",
      anomalous: false,
    });
    // Recovery: error-rate drops to zero — one-sided, not an anomaly.
    cases.push({
      name: `error-recovery#${v}`,
      category: "one-sided",
      points: series([
        ...Array.from({ length: 25 }, () => 15 + Math.abs(noise(2))),
        ...Array.from({ length: 6 }, () => 0),
      ]),
      metricKind: "error_rate",
      anomalous: false,
    });
    // Diurnal pattern, sampled within a normal nightly trough — the
    // seasonality-aware baseline must treat this as expected.
    {
      const pts: SeasonalPoint[] = [];
      for (let d = 0; d < 6; d++) {
        for (let h = 0; h < 24; h++) {
          const night = h >= 22 || h <= 5;
          pts.push({ timestamp: T0 + (d * 24 + h) * HOUR, value: (night ? 10 : 100) + noise(2) });
        }
      }
      cases.push({
        name: `diurnal-trough#${v}`,
        category: "seasonal",
        points: pts.slice(0, 6 * 24 - 20), // ends mid-night
        metricKind: "generic",
        anomalous: false,
      });
    }
  }

  // --- HARD TIER -------------------------------------------------------
  // Deliberately ambiguous / low-SNR cases. A perfect score here would be a
  // sign the suite is too easy; we publish whatever the engine actually does.
  for (let v = 0; v < 4; v++) {
    const r = rng(7000 + v);
    const noise = (amp: number) => (r() - 0.5) * 2 * amp;

    // Low-SNR ramp: real leak, but noise amplitude ~ the per-step rise.
    cases.push({
      name: `noisy-ramp#${v}`,
      category: "hard",
      points: series(Array.from({ length: 38 }, (_, i) => 100 + i * 3 + noise(9)), HOUR / 6),
      metricKind: "saturation",
      anomalous: true,
    });
    // Modest step (≈3σ) just above the recent baseline.
    cases.push({
      name: `small-step#${v}`,
      category: "hard",
      points: series([
        ...Array.from({ length: 25 }, () => 100 + noise(5)),
        ...Array.from({ length: 6 }, () => 122 + noise(5)),
      ]),
      metricKind: "latency",
      anomalous: true,
    });
    // Heavy noise, no real shift — must NOT alarm.
    cases.push({
      name: `heavy-noise-stable#${v}`,
      category: "hard",
      points: series(Array.from({ length: 40 }, () => 100 + noise(18))),
      metricKind: "generic",
      anomalous: false,
    });
    // Two-point blip (still below dwell-sustained) — must NOT alarm.
    cases.push({
      name: `double-blip#${v}`,
      category: "hard",
      points: series([
        ...Array.from({ length: 32 }, () => 60 + noise(4)),
        300,
        300,
        ...Array.from({ length: 4 }, () => 60 + noise(4)),
      ]),
      metricKind: "latency",
      anomalous: false,
    });
  }

  return cases;
}

export interface BacktestReport {
  total: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  byCategory: Record<string, { total: number; correct: number }>;
}

export function runBacktest(cases: BacktestCase[] = buildSuite()): BacktestReport {
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0;
  const byCategory: Record<string, { total: number; correct: number }> = {};

  for (const c of cases) {
    const verdict = detectAnomaly(c.points, { metricKind: c.metricKind }).isAnomaly;
    const correct = verdict === c.anomalous;
    if (verdict && c.anomalous) tp++;
    else if (verdict && !c.anomalous) fp++;
    else if (!verdict && !c.anomalous) tn++;
    else fn++;

    const cat = (byCategory[c.category] ??= { total: 0, correct: 0 });
    cat.total++;
    if (correct) cat.correct++;
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return { total: cases.length, tp, fp, tn, fn, precision, recall, f1, byCategory };
}

export function formatReport(r: BacktestReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `Backtest: ${r.total} labelled cases`,
    `  TP=${r.tp} FP=${r.fp} TN=${r.tn} FN=${r.fn}`,
    `  precision=${pct(r.precision)} recall=${pct(r.recall)} F1=${pct(r.f1)}`,
    `  by category:`,
    ...Object.entries(r.byCategory).map(
      ([k, v]) => `    ${k}: ${v.correct}/${v.total}`
    ),
  ];
  return lines.join("\n");
}
