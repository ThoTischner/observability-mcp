import { Agent } from "node:https";
import type { ObservabilityConnector } from "./interface.js";
import type {
  SourceConfig,
  SourceAuth,
  ConnectorHealth,
  ServiceInfo,
  MetricDefinition,
  LogQuery,
  LogResult,
  LogEntry,
  LogAggregateQuery,
  LogAggregateResult,
  LogAggregateSeries,
  SignalType,
} from "../types.js";
import { buildTlsAgent } from "./tls.js";

const DEFAULT_SERVICE_LABELS = ["service_name", "service", "job", "app", "container"];
const LABEL_CACHE_TTL_MS = 60_000;

/** Escape a value for a double-quoted LogQL string literal. Backslash and
 *  quote first (breakout chars), then control chars — a raw newline/tab in
 *  a Go-style `"..."` literal is a parse error, so emit the escape sequence. */
export function escapeLogQLValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Compile a `labels` equality map into LogQL label-filter expressions that
 * run AFTER `| json`, e.g. `{...} | json | method="GET" | status="200"`.
 * Placed after the json parse so fields the pipeline extracts (not just
 * stream labels) are filterable. Keys are sorted for deterministic output.
 * Reusable, side-effect-free unit — also the basis for the Q-LOG2
 * aggregation path and a future named-LogQL catalog. Callers validate the
 * map (see validateLogLabels); this only escapes values.
 */
export function logqlLabelFilters(labels: Record<string, string> | undefined): string {
  if (!labels) return "";
  return Object.keys(labels)
    .sort()
    .map((k) => ` | ${k}="${escapeLogQLValue(labels[k])}"`)
    .join("");
}

/**
 * Derive a log level from an HTTP status code when the line carries no
 * explicit level: 5xx → error, 4xx → warn. Returns undefined otherwise so
 * the caller keeps its existing fallback chain.
 */
export function levelFromStatus(status: unknown): "error" | "warn" | undefined {
  const n = typeof status === "number" ? status : parseInt(String(status ?? ""), 10);
  if (!Number.isFinite(n)) return undefined;
  if (n >= 500 && n <= 599) return "error";
  if (n >= 400 && n <= 499) return "warn";
  return undefined;
}

/** Parse a `<n><m|h|d>` duration into seconds. Returns null when malformed. */
export function parseDurationSeconds(duration: string): number | null {
  const m = /^(\d+)([mhd])$/.exec(duration);
  if (!m) return null;
  const v = parseInt(m[1], 10);
  return m[2] === "m" ? v * 60 : m[2] === "h" ? v * 3600 : v * 86400;
}

/** Pick a bucket size (seconds) that yields ~60 points across the window,
 *  floored at 60s, so a count_over_time range query isn't absurdly dense. */
export function defaultBucketSeconds(durationSeconds: number): number {
  return Math.max(60, Math.floor(durationSeconds / 60));
}

export interface AggregateLogQL {
  logql: string;
  /** instant (vector) for sum/topk; range (matrix) for count_over_time. */
  mode: "instant" | "range";
  /** Step for the range query, e.g. "300s". Only set when mode === "range". */
  step?: string;
}

/**
 * Wrap a stream+pipeline expression (`{sel} | json | …`) in a LogQL metric
 * aggregation. Pure + side-effect-free so it's unit-testable without a
 * backend. `by` labels are assumed pre-validated (label-name shape).
 */
export function buildAggregateLogQL(
  streamPipeline: string,
  agg: { op: "count_over_time" | "sum" | "topk"; by?: string[]; k?: number; step?: string },
  duration: string,
): AggregateLogQL {
  const durSec = parseDurationSeconds(duration) ?? 3600;
  const byClause = agg.by && agg.by.length ? ` by (${agg.by.join(", ")})` : "";

  if (agg.op === "count_over_time") {
    const stepSec = (agg.step && parseDurationSeconds(agg.step)) || defaultBucketSeconds(durSec);
    const inner = `count_over_time(${streamPipeline} [${stepSec}s])`;
    const logql = byClause ? `sum${byClause} (${inner})` : inner;
    return { logql, mode: "range", step: `${stepSec}s` };
  }

  // sum / topk: count over the whole window, then aggregate → instant vector.
  const totals = `sum${byClause} (count_over_time(${streamPipeline} [${durSec}s]))`;
  if (agg.op === "topk") {
    const k = agg.k && agg.k > 0 ? Math.floor(agg.k) : 10;
    return { logql: `topk(${k}, ${totals})`, mode: "instant" };
  }
  return { logql: totals, mode: "instant" };
}

export class LokiConnector implements ObservabilityConnector {
  readonly type = "loki";
  readonly signalType: SignalType = "logs";
  name = "";
  private baseUrl = "";
  private auth?: SourceAuth;
  private tlsAgent?: Agent;
  private serviceLabels: string[] = DEFAULT_SERVICE_LABELS;
  private labelValuesCache = new Map<string, { values: string[]; expiresAt: number }>();

  async connect(config: SourceConfig): Promise<void> {
    this.name = config.name;
    this.baseUrl = config.url.replace(/\/$/, "");
    this.auth = config.auth;
    this.tlsAgent = buildTlsAgent(config);
    const envLabels = process.env.LOKI_SERVICE_LABELS;
    if (envLabels) {
      this.serviceLabels = envLabels.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  getDefaultMetrics(): MetricDefinition[] {
    // Loki is a log backend — no metric definitions by default
    return [];
  }

  getMetrics(): MetricDefinition[] {
    return [];
  }

  private fetchOptions(): RequestInit {
    const opts: RequestInit = { headers: this.buildAuthHeaders() };
    if (this.tlsAgent) {
      // @ts-expect-error Node.js extension for native fetch
      opts.dispatcher = this.tlsAgent;
    }
    return opts;
  }

  async healthCheck(): Promise<ConnectorHealth> {
    const start = Date.now();
    try {
      // Use the labels query API instead of /ready: managed Loki (Grafana
      // Cloud, etc.) does not expose the operational health endpoint.
      // /loki/api/v1/labels returns 200 with auth on any reachable Loki.
      const res = await fetch(
        `${this.baseUrl}/loki/api/v1/labels`,
        this.fetchOptions()
      );
      return {
        status: res.ok ? "up" : "down",
        latencyMs: Date.now() - start,
        message: res.ok ? "Loki is ready" : `HTTP ${res.status}`,
      };
    } catch (err) {
      return { status: "down", latencyMs: Date.now() - start, message: String(err) };
    }
  }

  async disconnect(): Promise<void> {}

  async listServices(): Promise<ServiceInfo[]> {
    // Candidate labels are ordered by preference (service_name, service,
    // job, app, container). The FIRST label that yields any values wins —
    // we do not union across labels. Unioning duplicated every service:
    // one real container is simultaneously `service="api-gateway"` and
    // `container="myproj-api-gateway-1"`, and a co-located shipper can add
    // unrelated `container` values (e.g. other compose/k8s containers on
    // the same Docker host). The ordered fallback still keeps streams
    // reachable on backends that only carry a low-priority label.
    const seen = new Map<string, ServiceInfo>();
    for (const label of this.serviceLabels) {
      const values = await this.getLabelValues(label);
      if (values.length === 0) continue;
      for (const raw of values) {
        // Docker's loki.source.docker writes container names with a leading '/'
        // (Docker API Names[0] convention). Strip it for display so the name
        // matches what the service-name validator and users will pass back in.
        const display = label === "container" ? raw.replace(/^\//, "") : raw;
        if (!seen.has(display)) {
          seen.set(display, {
            name: display,
            source: this.name,
            signalType: "logs" as const,
            labels: { discoveredVia: label },
          });
        }
      }
      break; // first non-empty label is authoritative
    }
    return Array.from(seen.values());
  }

  async queryLogs(params: LogQuery): Promise<LogResult> {
    const { start, end } = this.parseTimeRange(params.duration);
    const limit = Math.min(Math.max(params.limit || 100, 1), 1000);

    // Resolve label + actual selector value. For the 'container' label the
    // value stored in Loki may be '/my-app-1' while the caller passes the
    // sanitized 'my-app-1' — return the prefixed form so the LogQL selector
    // matches the real stream.
    const { label: matchedLabel, value: rawValue } = await this.resolveServiceSelector(params.service);
    const service = this.escapeLogQLValue(rawValue);
    let logql = `{${matchedLabel}="${service}"} | json`;
    if (params.level) {
      logql += ` | level="${this.escapeLogQLValue(params.level)}"`;
    }
    // Structured equality filters (method/status/url/environment/…) — run
    // after `| json` so backend-extracted fields are selectable.
    logql += logqlLabelFilters(params.labels);
    if (params.query) {
      const query = this.escapeLogQLRegex(params.query);
      logql += ` |~ \`${query}\``;
    }

    const url =
      `/loki/api/v1/query_range?query=${encodeURIComponent(logql)}` +
      `&start=${start}000000000&end=${end}000000000&limit=${limit}`;

    const data = await this.apiGet<LokiQueryResponse>(url);

    const entries: LogEntry[] = [];
    for (const stream of data?.data?.result || []) {
      const labels = stream.stream;
      for (const [ts, line] of stream.values) {
        const parsed = this.parseLine(line);
        // Prefer an explicit level; otherwise derive one from an HTTP
        // status field (5xx→error, 4xx→warn) so structured access logs
        // that carry `status` but no `level` are still filterable/triaged.
        const level =
          parsed.level ||
          labels.level ||
          levelFromStatus(parsed.status ?? labels.status) ||
          "unknown";
        entries.push({
          timestamp: new Date(parseInt(ts) / 1_000_000).toISOString(),
          level,
          message: parsed.msg || line,
          labels,
        });
      }
    }

    // Sort newest first
    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    // Compute summary
    const errorCount = entries.filter((e) => e.level === "error").length;
    const warnCount = entries.filter((e) => e.level === "warn").length;
    const topPatterns = this.extractTopPatterns(entries.filter((e) => e.level === "error"));

    return {
      source: this.name,
      service: params.service,
      entries,
      summary: {
        total: entries.length,
        errorCount,
        warnCount,
        topPatterns,
      },
    };
  }

  async queryLogAggregate(params: LogAggregateQuery): Promise<LogAggregateResult> {
    const { start, end } = this.parseTimeRange(params.duration);
    const { label: matchedLabel, value: rawValue } = await this.resolveServiceSelector(params.service);
    const service = this.escapeLogQLValue(rawValue);

    // Same stream + pipeline prefix as queryLogs (reuses the Q-LOG1 unit),
    // minus the level filter (aggregation groups, it doesn't level-filter).
    let pipeline = `{${matchedLabel}="${service}"} | json`;
    pipeline += logqlLabelFilters(params.labels);
    if (params.query) {
      pipeline += ` |~ \`${this.escapeLogQLRegex(params.query)}\``;
    }

    const { logql, mode, step } = buildAggregateLogQL(
      pipeline,
      { op: params.op, by: params.by, k: params.k, step: params.step },
      params.duration,
    );

    const by = params.by ?? [];
    const series: LogAggregateSeries[] = [];

    if (mode === "instant") {
      const url = `/loki/api/v1/query?query=${encodeURIComponent(logql)}&time=${end}000000000`;
      const data = await this.apiGet<LokiMetricResponse>(url);
      for (const r of data?.data?.result || []) {
        const v = Array.isArray(r.value) ? Number(r.value[1]) : NaN;
        series.push({ labels: r.metric || {}, value: Number.isFinite(v) ? v : 0 });
      }
      // topk is already ordered by Loki; sort sum desc for a stable, useful view.
      series.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    } else {
      // `step` from the builder is `<n>s`; the query_range step param wants seconds.
      const stepSec = step ? parseInt(step, 10) || 60 : 60;
      const url =
        `/loki/api/v1/query_range?query=${encodeURIComponent(logql)}` +
        `&start=${start}000000000&end=${end}000000000&step=${stepSec}`;
      const data = await this.apiGet<LokiMetricResponse>(url);
      for (const r of data?.data?.result || []) {
        const points = (r.values || []).map(([ts, val]) => ({
          t: Math.round(Number(ts) * 1000),
          value: Number(val),
        }));
        series.push({ labels: r.metric || {}, points });
      }
    }

    return {
      source: this.name,
      op: params.op,
      by,
      step: mode === "range" ? step : undefined,
      mode,
      series,
      note: "Aggregate mode: `limit` does not apply (results are grouped counts, not raw rows).",
    };
  }

  // --- Private helpers ---

  private async getLabelValues(label: string): Promise<string[]> {
    const cached = this.labelValuesCache.get(label);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.values;
    }
    try {
      const data = await this.apiGet<{ data: string[] }>(
        `/loki/api/v1/label/${encodeURIComponent(label)}/values`
      );
      const values = data?.data || [];
      this.labelValuesCache.set(label, {
        values,
        expiresAt: Date.now() + LABEL_CACHE_TTL_MS,
      });
      return values;
    } catch {
      this.labelValuesCache.set(label, { values: [], expiresAt: Date.now() + LABEL_CACHE_TTL_MS });
      return [];
    }
  }

  private async resolveServiceSelector(service: string): Promise<{ label: string; value: string }> {
    for (const label of this.serviceLabels) {
      const values = await this.getLabelValues(label);
      if (values.includes(service)) return { label, value: service };
      // Container label values are Docker-prefixed with '/'. The caller can't
      // pass that form (validator rejects '/'), so probe the prefixed variant.
      if (label === "container" && values.includes(`/${service}`)) {
        return { label, value: `/${service}` };
      }
    }
    return { label: this.serviceLabels[0] || "service_name", value: service };
  }

  private parseLine(line: string): Record<string, string> {
    try {
      return JSON.parse(line);
    } catch {
      return { msg: line };
    }
  }

  private extractTopPatterns(errorEntries: LogEntry[]): string[] {
    const patterns = new Map<string, number>();
    for (const entry of errorEntries) {
      // Use first 100 chars of message as pattern key
      const key = entry.message.slice(0, 100);
      patterns.set(key, (patterns.get(key) || 0) + 1);
    }
    return Array.from(patterns.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([pattern, count]) => `${pattern} (${count}x)`);
  }

  private parseTimeRange(duration: string) {
    const now = Math.floor(Date.now() / 1000);
    const match = duration.match(/^(\d+)([mhd])$/);
    if (!match) throw new Error(`Invalid duration: ${duration}`);
    const value = parseInt(match[1]);
    const unit = match[2];
    const seconds = unit === "m" ? value * 60 : unit === "h" ? value * 3600 : value * 86400;
    return { start: now - seconds, end: now };
  }

  private escapeLogQLValue(value: string): string {
    // Delegate to the canonical module-level escaper (single source of truth).
    return escapeLogQLValue(value);
  }

  private escapeLogQLRegex(value: string): string {
    // Escape backslash first (so we don't double-escape sequences we add),
    // then the backtick that delimits LogQL regex literals.
    return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
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

  private async apiGet<T>(path: string, timeoutMs = 10000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...this.fetchOptions(),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Loki API error: ${res.status} ${res.statusText}`);
      return res.json() as Promise<T>;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(`Loki query timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

// Loki API types
interface LokiQueryResponse {
  data: {
    resultType: string;
    result: Array<{
      stream: Record<string, string>;
      values: Array<[string, string]>;
    }>;
  };
}

/** Metric-query (vector/matrix) response from Loki's query / query_range. */
interface LokiMetricResponse {
  data: {
    resultType: string;
    result: Array<{
      metric: Record<string, string>;
      /** Present for vector (instant) results: [unixSeconds, "value"]. */
      value?: [number, string];
      /** Present for matrix (range) results. */
      values?: Array<[number, string]>;
    }>;
  };
}
