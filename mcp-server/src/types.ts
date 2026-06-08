// --- Signal Types ---
export type SignalType = "metrics" | "logs" | "traces" | "topology";
export type HealthStatus = "healthy" | "degraded" | "critical";
export type Trend = "rising" | "falling" | "stable";
export type AnomalySeverity = "low" | "medium" | "high";

// --- Configuration ---

/** A metric definition tied to a specific connector type's query language */
export interface MetricDefinition {
  name: string;           // friendly name used in MCP tools, e.g. "cpu"
  query: string;          // backend-specific query (PromQL, LogQL, Flux, etc.)
  unit: string;           // "percent", "bytes", "req/s", "seconds", etc.
  description: string;    // what this metric measures
}

export interface SourceAuth {
  type: "none" | "basic" | "bearer";
  username?: string;       // for basic auth
  password?: string;       // for basic auth
  token?: string;          // for bearer token
}

export interface SourceTls {
  skipVerify?: boolean;    // skip all TLS verification (insecure)
  caCert?: string;         // path to custom CA certificate PEM file
  clientCert?: string;     // path to client certificate PEM file (mTLS)
  clientKey?: string;      // path to client private key PEM file (mTLS)
}

export interface SourceConfig {
  name: string;
  type: string;           // "prometheus", "loki", etc.
  url: string;
  enabled: boolean;
  auth?: SourceAuth;       // optional authentication
  tls?: SourceTls;         // TLS configuration
  /** @deprecated Use tls.skipVerify instead */
  tlsSkipVerify?: boolean;
  metrics?: MetricDefinition[];  // per-source metric definitions (overrides connector defaults)
  /** Tenant this source belongs to. When set, only requests in that
   *  tenant see / can target the source — cross-tenant access returns
   *  the same not-found posture as the rest of the tenancy layer.
   *  Unset = global source, available to every tenant (preserves
   *  pre-E7 single-tenant behaviour as the default). */
  tenant?: string;
}

export interface GeneralSettings {
  checkIntervalMs: number;
  defaultSensitivity: "low" | "medium" | "high";
}

export interface HealthThresholds {
  weights: {
    errorRate: number;
    latency: number;
    cpu: number;
    logErrors: number;
  };
  cpu: { good: number; warn: number; crit: number };
  errorRate: { good: number; warn: number; crit: number };
  latencyP99: { good: number; warn: number; crit: number };
  logErrors: { good: number; warn: number; crit: number };
  statusBoundaries: { healthy: number; degraded: number };
}

export interface Config {
  sources: SourceConfig[];
  settings: GeneralSettings;
  healthThresholds: HealthThresholds;
}

// --- Connector Types ---
export interface ConnectorHealth {
  status: "up" | "down";
  latencyMs: number;
  message?: string;
}

export interface ServiceInfo {
  name: string;
  source: string;
  signalType: SignalType;
  labels?: Record<string, string>;
}

export interface MetricInfo {
  name: string;
  type: string;
  help: string;
  unit?: string;
}

// --- Query Parameters ---
export interface MetricQuery {
  service: string;
  metric: string;
  duration: string; // "5m", "1h", "24h"
  step?: string;
  groupBy?: string; // label to break the result down by (e.g. "instance", "pod")
}

export interface LogQuery {
  service: string;
  query?: string;
  duration: string;
  limit?: number;
  level?: string;
  /** Structured label/field equality filters, AND'd together. For Loki
   *  these compile to LogQL label-filter expressions after `| json`, so
   *  fields the backend already extracts (method, status, url, ip,
   *  environment, …) become first-class selectors instead of brittle
   *  free-text regex. */
  labels?: Record<string, string>;
}

// --- Query Results (Unified Data Model) ---
export interface DataPoint {
  timestamp: string; // ISO 8601
  value: number;
}

export interface MetricSummary {
  current: number;
  average: number;
  min: number;
  max: number;
  trend: Trend;
}

export interface MetricGroup {
  key: string;
  values: DataPoint[];
  summary: MetricSummary;
}

export interface MetricResult {
  source: string;
  service: string;
  metric: string;
  unit: string;
  values: DataPoint[];
  summary: MetricSummary;
  resolvedSeries?: string;   // The actual PromQL executed (for debugging when auto-resolved)
  resolvedLabel?: string;    // Which label (job/service/app/...) the service was matched on
  groupBy?: string;          // Label the result was broken down by
  groups?: MetricGroup[];    // Per-group time-series (set when groupBy was requested and >1 group exists)
  hint?: string;             // Suggestion when caller may want a different query shape
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  labels: Record<string, string>;
}

export interface LogSummary {
  total: number;
  errorCount: number;
  warnCount: number;
  topPatterns: string[];
}

export interface LogResult {
  source: string;
  service: string;
  entries: LogEntry[];
  summary: LogSummary;
}

// --- Traces (since v2.x) ---

export interface TraceQuery {
  /** Service name to filter by — required. */
  service: string;
  /** Rolling time window, same shape as MetricQuery.duration ("5m", "1h", "24h"). */
  duration: string;
  /** Free-form filter pattern interpreted by the backend (TraceQL,
   *  Jaeger tag query, etc.). Optional. */
  filter?: string;
  /** Soft cap on the number of trace summaries returned. Default 50. */
  limit?: number;
  /** Only return spans tagged as errors (`status: error` / span status 2). */
  errorsOnly?: boolean;
}

export interface TraceSpanSummary {
  /** Stable trace id (hex). */
  traceId: string;
  /** Root or first span name. */
  rootName: string;
  /** Service that emitted the root span. */
  rootService: string;
  /** Total trace duration in milliseconds. */
  durationMs: number;
  /** Span count. */
  spanCount: number;
  /** Whether any span in this trace has an error status. */
  hasError: boolean;
  /** Span start timestamp (RFC-3339). */
  startTs: string;
  /** Optional backend-specific link to the trace view. */
  url?: string;
}

export interface TraceSummary {
  total: number;
  errorCount: number;
  /** Median trace duration (ms) across the returned set. */
  p50DurationMs: number;
  /** 95th-percentile trace duration (ms). */
  p95DurationMs: number;
}

export interface TraceResult {
  source: string;
  service: string;
  traces: TraceSpanSummary[];
  summary: TraceSummary;
}

// --- Topology ---

/**
 * A discrete infrastructure entity discovered by a topology-aware connector.
 *
 * `kind` and the relation strings on Edge are intentionally open (not unions):
 * future connectors (vCenter, NetBox, SNMP, ...) will introduce new kinds and
 * relations. Document common values here, but do not hard-restrict the type.
 *
 * `id` is a stable, human-readable canonical key. For Kubernetes we use
 *   `k8s:<kind>:<namespace>/<name>` for namespaced kinds, `k8s:<kind>:<name>`
 *   for cluster-scoped kinds. Pod names are ephemeral by design — that's
 *   acceptable since pods are short-lived; deployments/nodes/services are
 *   stable. Backend identifiers (e.g. K8s metadata.uid) belong in `attributes`.
 *
 * `source` is mandatory so a future entity-resolution layer can merge views
 * from multiple connectors without ambiguity.
 *
 * Common kinds (Kubernetes): "pod", "node", "deployment", "service", "namespace".
 */
export interface Resource {
  id: string;
  kind: string;
  name: string;
  source: string;
  labels: Record<string, string>;
  attributes?: Record<string, unknown>;
}

/**
 * A directed relationship between two Resources.
 *
 * Common relations (Kubernetes):
 *   - "RUNS_ON"      pod -> node, container -> host, vm -> hypervisor
 *   - "OWNED_BY"     pod -> replicaset/deployment
 *   - "ROUTES_TO"    service -> pod
 *   - "IN_NAMESPACE" pod/service/deployment -> namespace
 *
 * `confidence` is 0..1. For data that comes straight from an authoritative
 * source (K8s API), use 1.0. Inferred relations (e.g. label-based matching)
 * should report lower values.
 */
export interface Edge {
  from: string;
  to: string;
  relation: string;
  source: string;
  confidence: number;
}

/** Snapshot of the topology graph as known by a single connector. */
export interface TopologySnapshot {
  source: string;
  resources: Resource[];
  edges: Edge[];
  /** Monotonic counter; bumped on each successful watch event apply. */
  revision: number;
}

/** Event emitted by a watching connector when its in-memory graph changes. */
export type TopologyChangeEvent =
  | { type: "resource_added" | "resource_updated" | "resource_removed"; resource: Resource }
  | { type: "edge_added" | "edge_removed"; edge: Edge }
  | { type: "resync"; snapshot: TopologySnapshot };

export type TopologyChangeListener = (event: TopologyChangeEvent) => void;

// --- Health & Anomaly ---
export interface AnomalyReport {
  metric: string;
  severity: AnomalySeverity;
  description: string;
  currentValue: number;
  baselineValue: number;
  deviationPercent: number;
  source: string;
  service: string;
}

export interface ServiceHealth {
  service: string;
  status: HealthStatus;
  score: number; // 0-100
  signals: {
    metrics: {
      cpu: number;
      memory: number;
      errorRate: number;
      latencyP99: number;
    };
    logs: {
      errorRate: number;
      topErrors: string[];
    };
  };
  anomalies: AnomalyReport[];
  correlations: string[];
}
