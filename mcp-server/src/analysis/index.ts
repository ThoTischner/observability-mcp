/**
 * Embeddable analysis library — the deterministic analysis engine
 * (anomaly detection, seasonality, causal root-cause, health scoring) usable
 * in-process, without running the MCP server or any transport.
 *
 *   import { analyzeMetric, rankRootCause, calculateHealthScore }
 *     from "@thotischner/observability-mcp/analysis";
 *
 * Same code path as the MCP tools — verdicts are identical whether reached via
 * the gateway or this library.
 */

export {
  // robust + seasonal + orchestrated anomaly detection
  detectAnomaly,
  detectRobustAnomaly,
  detectSeasonalAnomaly,
  detectRecentAnomaly,
  detectAnomalyPoints,
  calculateZScore,
  classifyMetric,
  median,
  mad,
  type MetricKind,
  type SeasonalPoint,
  type SeasonalAnomalyOptions,
  type SeasonalAnomalyResult,
  type RobustAnomalyOptions,
  type RobustAnomalyResult,
  type AnomalyPoint,
  type ZScoreResult,
} from "./anomaly.js";

export {
  correlateSignals,
  rankRootCause,
  type ServiceEdge,
  type RankInputAnomaly,
  type ChangeMarker,
  type RootCauseCandidate,
  type RootCauseResult,
} from "./correlator.js";

export {
  calculateHealthScore,
  type HealthInputs,
  type HealthResult,
} from "./health.js";

import { detectAnomaly, classifyMetric, type SeasonalPoint } from "./anomaly.js";

/**
 * One-call façade: classify the metric by name and run the orchestrated
 * detector (seasonal when enough history, else robust). Thin convenience over
 * {@link detectAnomaly}; identical result to calling it directly with the
 * classified `metricKind`.
 */
export function analyzeMetric(
  metric: string,
  points: SeasonalPoint[],
  opts: { threshold?: number } = {}
) {
  return detectAnomaly(points, {
    metricKind: classifyMetric(metric),
    threshold: opts.threshold,
  });
}
