// --- Signal Types ---
export type SignalType = "metrics" | "logs" | "traces";
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
}

export interface LogQuery {
  service: string;
  query?: string;
  duration: string;
  limit?: number;
  level?: string;
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

export interface MetricResult {
  source: string;
  service: string;
  metric: string;
  unit: string;
  values: DataPoint[];
  summary: MetricSummary;
  resolvedSeries?: string;   // The actual PromQL executed (for debugging when auto-resolved)
  resolvedLabel?: string;    // Which label (job/service/app/...) the service was matched on
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
