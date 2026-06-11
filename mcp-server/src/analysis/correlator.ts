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
      if (metric.summary && metric.summary.trend === "rising") {
        correlations.push(
          `${anomaly.service}: ${anomaly.metric} anomaly coincides with rising ${metric.metric} ` +
          `(current: ${metric.summary.current.toFixed(2)})`
        );
      }
    }
  }

  return [...new Set(correlations)]; // Deduplicate
}

// ---------------------------------------------------------------------------
// Dependency-aware root-cause ranking (A4)
//
// "both signals are bad" is not a diagnosis. When several services are
// anomalous at once, the useful answer is *which one is the cause*. We rank
// candidates by combining three independent signals:
//   1. Dependency position — a failing service that others *depend on*
//      explains their symptoms; callers are downstream victims.
//   2. Onset ordering — the anomaly that started first is more likely causal.
//   3. A recent deploy/change marker near onset — a strong cause hint.
// Signal breadth/severity is a tie-breaker, not a primary signal (a loud
// downstream symptom must not outrank a quiet upstream root cause).
// ---------------------------------------------------------------------------

/** Directed edge: `from` calls / depends on `to`. */
export interface ServiceEdge {
  from: string;
  to: string;
}

export interface RankInputAnomaly {
  service: string;
  metric: string;
  severity: "low" | "medium" | "high";
  /** Epoch ms when the anomaly first breached, if known. Lower = earlier. */
  onsetTs?: number;
}

export interface ChangeMarker {
  service: string;
  /** Epoch ms of a deploy / config change / rollout. */
  ts: number;
  kind?: string;
}

export interface RootCauseCandidate {
  service: string;
  score: number;
  confidence: "low" | "medium" | "high";
  reasons: string[];
}

export interface RootCauseResult {
  ranked: RootCauseCandidate[];
  summary: string;
}

const SEV_WEIGHT = { low: 1, medium: 2, high: 3 } as const;

/**
 * Rank likely root-cause services among co-occurring anomalies.
 *
 * `edges` is the (caller → callee) service graph; it may be empty, in which
 * case ranking falls back to onset ordering + change markers + severity.
 */
export function rankRootCause(
  anomalies: RankInputAnomaly[],
  edges: ServiceEdge[] = [],
  changes: ChangeMarker[] = []
): RootCauseResult {
  const services = [...new Set(anomalies.map((a) => a.service))];
  if (services.length === 0) {
    return { ranked: [], summary: "No anomalies to attribute." };
  }

  // "depends on": from -> set(to). A root cause is a service that other
  // anomalous services (transitively) depend on.
  const deps = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!deps.has(e.from)) deps.set(e.from, new Set());
    deps.get(e.from)!.add(e.to);
  }
  const dependsOn = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (seen.has(from)) return false;
    seen.add(from);
    const direct = deps.get(from);
    if (!direct) return false;
    if (direct.has(to)) return true;
    for (const mid of direct) if (dependsOn(mid, to, seen)) return true;
    return false;
  };

  const earliest = Math.min(
    ...anomalies.filter((a) => a.onsetTs !== undefined).map((a) => a.onsetTs!)
  );
  const haveOnset = Number.isFinite(earliest);

  const candidates: RootCauseCandidate[] = services.map((svc) => {
    const svcAnoms = anomalies.filter((a) => a.service === svc);
    const reasons: string[] = [];
    let score = 0;

    // (1) Dependency position: how many *other* anomalous services depend on
    // this one. Each dependent is a downstream symptom this service explains.
    const dependents = services.filter(
      (other) => other !== svc && dependsOn(other, svc)
    );
    if (dependents.length > 0) {
      score += 5 * dependents.length;
      reasons.push(
        `${dependents.length} anomalous service(s) depend on it (${dependents.join(", ")}) — their symptoms are likely downstream`
      );
    }
    // Penalty: this service depends on another anomalous one → likely a victim.
    const upstreamCauses = services.filter(
      (other) => other !== svc && dependsOn(svc, other)
    );
    if (upstreamCauses.length > 0) {
      score -= 3 * upstreamCauses.length;
      reasons.push(`depends on anomalous ${upstreamCauses.join(", ")} — may be a downstream victim`);
    }

    // (2) Onset ordering: started at/near the earliest onset.
    if (haveOnset) {
      const myOnset = Math.min(
        ...svcAnoms.filter((a) => a.onsetTs !== undefined).map((a) => a.onsetTs!)
      );
      if (Number.isFinite(myOnset)) {
        const lagSec = Math.round((myOnset - earliest) / 1000);
        if (lagSec <= 0) {
          score += 4;
          reasons.push("anomaly started first (earliest onset)");
        } else if (lagSec <= 60) {
          score += 1;
          reasons.push(`onset ${lagSec}s after the first signal`);
        } else {
          reasons.push(`onset ${lagSec}s after the first signal — likely reactive`);
        }
      }
    }

    // (3) Deploy/change marker shortly before onset.
    const myOnset = svcAnoms.find((a) => a.onsetTs !== undefined)?.onsetTs;
    const marker = changes
      .filter((c) => c.service === svc)
      .find((c) => myOnset === undefined || (c.ts <= myOnset && myOnset - c.ts <= 15 * 60_000));
    if (marker) {
      score += 4;
      reasons.push(
        `${marker.kind || "change"} on this service ${
          myOnset ? `${Math.round((myOnset - marker.ts) / 1000)}s before onset` : "near the incident"
        }`
      );
    }

    // Tie-breaker: signal breadth × severity (small weight).
    const breadth = svcAnoms.reduce((s, a) => s + SEV_WEIGHT[a.severity], 0);
    score += 0.25 * breadth;

    return { service: svc, score, confidence: "low" as const, reasons };
  });

  candidates.sort((a, b) => b.score - a.score);

  // Confidence from the score gap between #1 and #2.
  const top = candidates[0];
  const gap = candidates.length > 1 ? top.score - candidates[1].score : top.score;
  top.confidence = gap >= 5 ? "high" : gap >= 2 ? "medium" : "low";

  const summary =
    candidates.length === 1
      ? `Single anomalous service: ${top.service}.`
      : `Likely root cause: ${top.service} (${top.confidence} confidence). ${
          top.reasons[0] || "ranked by severity"
        }. ${candidates.length - 1} other service(s) likely downstream.`;

  return { ranked: candidates, summary };
}
