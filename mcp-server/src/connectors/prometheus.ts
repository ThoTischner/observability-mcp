import { Agent } from "node:https";
import type { ObservabilityConnector } from "./interface.js";
import type {
  SourceConfig,
  SourceAuth,
  ConnectorHealth,
  ServiceInfo,
  MetricInfo,
  MetricQuery,
  MetricResult,
  MetricDefinition,
  DataPoint,
  Trend,
  SignalType,
} from "../types.js";
import { buildTlsAgent } from "./tls.js";

// Defaults target prom-client conventions, the de-facto standard for
// Node.js/Express instrumentation and what most apps emit out of the box.
// {{selector}} is replaced at query time with the discovered label/value
// pair (e.g. job="my-svc"); the connector probes job → service → app →
// service_name to find which label carries the requested service name.
// {{service}} (literal value) is still supported for back-compat with
// user-provided overrides.
const DEFAULT_PROMETHEUS_METRICS: MetricDefinition[] = [
  {
    name: "cpu",
    query: 'rate(process_cpu_seconds_total{ {{selector}} }[1m]) * 100',
    unit: "percent",
    description: "CPU usage % (rate of process_cpu_seconds_total — prom-client default)",
  },
  {
    name: "memory",
    query: 'process_resident_memory_bytes{ {{selector}} }',
    unit: "bytes",
    description: "Resident memory in bytes (prom-client default)",
  },
  {
    name: "request_rate",
    query: 'sum(rate(http_requests_total{ {{selector}} }[1m]))',
    unit: "req/s",
    description: "HTTP request rate",
  },
  {
    name: "error_rate",
    query: 'sum(rate(http_requests_total{ {{selector}}, status=~"5.." }[1m]))',
    unit: "req/s",
    description: "HTTP 5xx error rate",
  },
  {
    name: "latency_p99",
    query: 'histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{ {{selector}} }[1m])) by (le))',
    unit: "seconds",
    description: "99th percentile latency",
  },
  {
    name: "latency_p50",
    query: 'histogram_quantile(0.50, sum(rate(http_request_duration_seconds_bucket{ {{selector}} }[1m])) by (le))',
    unit: "seconds",
    description: "50th percentile latency",
  },
  {
    name: "latency_avg",
    query: 'sum(rate(http_request_duration_seconds_sum{ {{selector}} }[1m])) / sum(rate(http_request_duration_seconds_count{ {{selector}} }[1m]))',
    unit: "seconds",
    description: "Average request latency",
  },
];

const DEFAULT_SERVICE_LABELS = ["job", "service", "app", "service_name"];
const LABEL_CACHE_TTL_MS = 60_000;

export class PrometheusConnector implements ObservabilityConnector {
  readonly type = "prometheus";
  readonly signalType: SignalType = "metrics";
  name = "";
  private baseUrl = "";
  private auth?: SourceAuth;
  private tlsAgent?: Agent;
  private metrics: MetricDefinition[] = [];
  private serviceLabels: string[] = DEFAULT_SERVICE_LABELS;
  private labelValuesCache = new Map<string, { values: string[]; expiresAt: number }>();

  async connect(config: SourceConfig): Promise<void> {
    this.name = config.name;
    this.baseUrl = config.url.replace(/\/$/, "");
    this.auth = config.auth;
    this.tlsAgent = buildTlsAgent(config);
    // Source-level overrides merge with defaults by name, so users can pin
    // a single metric (e.g. cpu) to a custom query without re-listing the
    // rest. To fully replace the defaults, override every metric explicitly.
    const overrides = new Map((config.metrics || []).map((m) => [m.name, m]));
    this.metrics = DEFAULT_PROMETHEUS_METRICS.map((d) => overrides.get(d.name) || d);
    for (const [name, m] of overrides) {
      if (!DEFAULT_PROMETHEUS_METRICS.some((d) => d.name === name)) {
        this.metrics.push(m);
      }
    }
    const envLabels = process.env.PROMETHEUS_SERVICE_LABELS;
    if (envLabels) {
      this.serviceLabels = envLabels.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  getDefaultMetrics(): MetricDefinition[] {
    return DEFAULT_PROMETHEUS_METRICS;
  }

  getMetrics(): MetricDefinition[] {
    return this.metrics;
  }

  setMetrics(metrics: MetricDefinition[]) {
    this.metrics = metrics;
  }

  async healthCheck(): Promise<ConnectorHealth> {
    const start = Date.now();
    try {
      // Use the query API instead of /-/ready: works on both OSS Prometheus
      // and managed offerings (Grafana Cloud / Mimir, AWS Managed Prometheus,
      // Chronosphere) which do not expose the operational health endpoint.
      // 'up' is a synthetic metric guaranteed to exist on any Prometheus.
      const res = await fetch(
        `${this.baseUrl}/api/v1/query?query=up`,
        this.fetchOptions()
      );
      return {
        status: res.ok ? "up" : "down",
        latencyMs: Date.now() - start,
        message: res.ok ? "Prometheus is ready" : `HTTP ${res.status}`,
      };
    } catch (err) {
      return { status: "down", latencyMs: Date.now() - start, message: String(err) };
    }
  }

  async disconnect(): Promise<void> {}

  async listServices(): Promise<ServiceInfo[]> {
    // Prefer /api/v1/targets — gives full label detail incl. service/job/address.
    // Managed Prometheus (Mimir, AMP, Chronosphere) returns 404 on this path
    // because targets are an operational concept of the OSS scraper. Fall back
    // to /api/v1/label/job/values, which is the canonical query-time source
    // for service names and is supported everywhere.
    try {
      const data = await this.apiGet<{ data: { activeTargets: PromTarget[] } }>(
        "/api/v1/targets"
      );
      const targets = data?.data?.activeTargets || [];
      if (targets.length === 0) {
        return await this.listServicesFromJobLabel();
      }
      const services = new Map<string, ServiceInfo>();
      for (const t of targets) {
        const name =
          t.labels?.service || t.labels?.job || t.discoveredLabels?.__address__ || "unknown";
        if (!services.has(name)) {
          services.set(name, {
            name,
            source: this.name,
            signalType: "metrics",
            labels: t.labels,
          });
        }
      }
      return Array.from(services.values());
    } catch (err) {
      const msg = String(err);
      if (msg.includes("404")) {
        return await this.listServicesFromJobLabel();
      }
      throw err;
    }
  }

  private async listServicesFromJobLabel(): Promise<ServiceInfo[]> {
    const data = await this.apiGet<{ data: string[] }>("/api/v1/label/job/values");
    const jobs = data?.data || [];
    return jobs.map((name) => ({
      name,
      source: this.name,
      signalType: "metrics" as const,
    }));
  }

  async listAvailableMetrics(_service: string): Promise<MetricInfo[]> {
    const data = await this.apiGet<{ data: Record<string, MetadataEntry[]> }>(
      "/api/v1/metadata"
    );
    if (!data?.data) return [];

    const metrics: MetricInfo[] = [];
    for (const [name, entries] of Object.entries(data.data)) {
      const entry = entries[0];
      if (entry) {
        metrics.push({ name, type: entry.type, help: entry.help, unit: entry.unit || undefined });
      }
    }
    return metrics;
  }

  async queryMetrics(params: MetricQuery): Promise<MetricResult> {
    const { promql, label } = await this.buildQuery(params.service, params.metric);
    const { start, end, step } = this.parseTimeRange(params.duration, params.step);

    const data = await this.apiGet<{ data: PromQueryRangeResult }>(
      `/api/v1/query_range?query=${encodeURIComponent(promql)}&start=${start}&end=${end}&step=${step}`
    );

    const values: DataPoint[] = [];
    const rawValues: number[] = [];

    const resultData = data?.data?.result?.[0]?.values || [];
    for (const [ts, val] of resultData) {
      const numVal = parseFloat(val as string);
      if (!isNaN(numVal)) {
        values.push({ timestamp: new Date(ts * 1000).toISOString(), value: numVal });
        rawValues.push(numVal);
      }
    }

    return {
      source: this.name,
      service: params.service,
      metric: params.metric,
      unit: this.getUnit(params.metric),
      values,
      summary: this.computeSummary(rawValues),
      resolvedSeries: promql,
      resolvedLabel: label,
    };
  }

  // --- Private helpers ---

  private async buildQuery(service: string, metric: string): Promise<{ promql: string; label: string }> {
    const def = this.metrics.find((m) => m.name === metric);
    const template = def?.query || `${metric}{ {{selector}} }`;
    const escaped = service.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    let promql = template;
    let label = "job";
    if (template.includes("{{selector}}")) {
      label = await this.resolveServiceLabel(service);
      const selector = `${label}="${escaped}"`;
      promql = promql.replace(/\{\{selector\}\}/g, selector);
    }
    promql = promql.replace(/\{\{service\}\}/g, escaped);
    return { promql, label };
  }

  private async resolveServiceLabel(service: string): Promise<string> {
    for (const label of this.serviceLabels) {
      const values = await this.getLabelValues(label);
      if (values.includes(service)) return label;
    }
    return this.serviceLabels[0] || "job";
  }

  private async getLabelValues(label: string): Promise<string[]> {
    const cached = this.labelValuesCache.get(label);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.values;
    }
    try {
      const data = await this.apiGet<{ data: string[] }>(
        `/api/v1/label/${encodeURIComponent(label)}/values`
      );
      const values = data?.data || [];
      this.labelValuesCache.set(label, { values, expiresAt: Date.now() + LABEL_CACHE_TTL_MS });
      return values;
    } catch {
      this.labelValuesCache.set(label, { values: [], expiresAt: Date.now() + LABEL_CACHE_TTL_MS });
      return [];
    }
  }

  private getUnit(metric: string): string {
    const def = this.metrics.find((m) => m.name === metric);
    if (def) return def.unit;
    return "";
  }

  private parseTimeRange(duration: string, step?: string) {
    const now = Math.floor(Date.now() / 1000);
    const match = duration.match(/^(\d+)([mhd])$/);
    if (!match) throw new Error(`Invalid duration: ${duration}`);
    const value = parseInt(match[1]);
    const unit = match[2];
    const seconds = unit === "m" ? value * 60 : unit === "h" ? value * 3600 : value * 86400;
    const autoStep = Math.max(Math.floor(seconds / 100), 5);
    return { start: now - seconds, end: now, step: step || `${autoStep}s` };
  }

  private computeSummary(values: number[]): MetricResult["summary"] {
    if (values.length === 0) {
      return { current: 0, average: 0, min: 0, max: 0, trend: "stable" };
    }
    const current = values[values.length - 1];
    const average = values.reduce((a, b) => a + b, 0) / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    return { current, average, min, max, trend: this.computeTrend(values) };
  }

  private computeTrend(values: number[]): Trend {
    if (values.length < 4) return "stable";
    const mid = Math.floor(values.length / 2);
    const avgFirst = values.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
    const avgSecond = values.slice(mid).reduce((a, b) => a + b, 0) / (values.length - mid);
    const changePercent = ((avgSecond - avgFirst) / (avgFirst || 1)) * 100;
    if (changePercent > 10) return "rising";
    if (changePercent < -10) return "falling";
    return "stable";
  }

  private buildAuthHeaders(): Record<string, string> {
    if (!this.auth || this.auth.type === "none") return {};
    if (this.auth.type === "bearer" && this.auth.token) {
      return { Authorization: `Bearer ${this.auth.token}` };
    }
    if (this.auth.type === "basic" && this.auth.username) {
      const encoded = Buffer.from(`${this.auth.username}:${this.auth.password || ""}`).toString("base64");
      return { Authorization: `Basic ${encoded}` };
    }
    return {};
  }

  private fetchOptions(): RequestInit {
    const opts: RequestInit = { headers: this.buildAuthHeaders() };
    if (this.tlsAgent) {
      // @ts-expect-error Node.js extension for native fetch
      opts.dispatcher = this.tlsAgent;
    }
    return opts;
  }

  private async apiGet<T>(path: string, timeoutMs = 10000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...this.fetchOptions(),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Prometheus API error: ${res.status} ${res.statusText}`);
      return res.json() as Promise<T>;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(`Prometheus query timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

// Prometheus API types
interface PromTarget {
  labels: Record<string, string>;
  discoveredLabels: Record<string, string>;
  health: string;
}

interface MetadataEntry {
  type: string;
  help: string;
  unit: string;
}

interface PromQueryRangeResult {
  resultType: string;
  result: Array<{
    metric: Record<string, string>;
    values: Array<[number, string]>;
  }>;
}
