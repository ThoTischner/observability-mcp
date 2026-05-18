// Grafana Tempo connector for observability-mcp. Tempo is the
// OTLP-native distributed-tracing backend: applications push spans over
// OTLP, Tempo stores them, and exposes a *query* HTTP API (TraceQL
// search + tag discovery). This connector turns that trace store into a
// signal the analysis engine already understands.
//
// Scope (deliberately narrow — honest over broad):
//   - signalType "metrics": it surfaces a TRACE-DERIVED service latency
//     series (one sample per matched trace, value = trace duration in
//     seconds). That feeds the same robust-anomaly / health path as any
//     Prometheus latency metric — no new tool surface, no dead code.
//   - listServices: real, from Tempo's `resource.service.name` tag
//     values.
// It does NOT claim raw-span retrieval, logs, or server-side rollups —
// those are out of scope for the query-connector contract and would be
// overclaiming.
//
// Standalone dependency-free ESM (Node 20 fetch), duck-typed against the
// ObservabilityConnector contract (no SDK import → self-contained,
// airgapped-mirrorable tarball).
//
// Auth: Tempo is commonly unauthenticated behind a gateway; an optional
// Bearer token (source auth token, or TEMPO_TOKEN) is sent when present.

function parseTimeRange(duration) {
  const m = String(duration || "").match(/^(\d+)([mhd])$/);
  if (!m) throw new Error(`invalid duration: ${duration} (use 5m, 1h, 24h)`);
  const n = parseInt(m[1], 10);
  const secs = m[2] === "m" ? n * 60 : m[2] === "h" ? n * 3600 : n * 86400;
  const end = Math.floor(Date.now() / 1000);
  return { start: end - secs, end };
}

function computeTrend(values) {
  if (values.length < 4) return "stable";
  const mid = Math.floor(values.length / 2);
  const a = values.slice(0, mid).reduce((x, y) => x + y, 0) / mid;
  const b = values.slice(mid).reduce((x, y) => x + y, 0) / (values.length - mid);
  const pct = ((b - a) / (a || 1)) * 100;
  return pct > 10 ? "rising" : pct < -10 ? "falling" : "stable";
}

function summarize(values) {
  if (values.length === 0) return { current: 0, average: 0, min: 0, max: 0, trend: "stable" };
  return {
    current: values[values.length - 1],
    average: values.reduce((a, b) => a + b, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    trend: computeTrend(values),
  };
}

// A Tempo search result trace carries durationMs; we expose it as a
// "latency" metric in SECONDS to match the rest of the connector fleet
// (Grafana/Datadog latency unit) so classifyMetric() treats it
// one-sided (a latency drop is good news, never an anomaly).
const DEFAULT_METRICS = [
  {
    name: "latency",
    query: '{ resource.service.name = "$service" }',
    unit: "seconds",
    description: "Per-trace service latency derived from Tempo trace durations",
  },
];
// Accepted aliases → all resolve to the trace-duration series.
const LATENCY_ALIASES = new Set(["latency", "latency_p99", "duration", "response_time"]);

export class TempoConnector {
  constructor() {
    this.name = "tempo";
    this.type = "tempo";
    this.signalType = "metrics";
    this._metrics = DEFAULT_METRICS;
    this._base = "";
    this._token = "";
  }

  async connect(config) {
    this._base = config && config.url ? String(config.url).replace(/\/$/, "") : "";
    if (!this._base) throw new Error("Tempo url is required");
    const auth = (config && config.auth) || {};
    this._token = auth.token || process.env.TEMPO_TOKEN || "";
    if (Array.isArray(config && config.metrics) && config.metrics.length > 0) {
      this._metrics = config.metrics;
    }
  }

  async disconnect() {
    /* stateless */
  }

  _headers() {
    return this._token ? { Authorization: `Bearer ${this._token}` } : {};
  }

  async healthCheck() {
    const started = Date.now();
    try {
      const res = await fetch(`${this._base}/ready`, { headers: this._headers() });
      const latencyMs = Date.now() - started;
      return res.ok
        ? { status: "up", latencyMs }
        : { status: "down", latencyMs, message: `Tempo /ready HTTP ${res.status}` };
    } catch (e) {
      return { status: "down", latencyMs: Date.now() - started, message: String(e) };
    }
  }

  getDefaultMetrics() {
    return DEFAULT_METRICS;
  }

  getMetrics() {
    return this._metrics;
  }

  async listServices() {
    try {
      const res = await fetch(
        `${this._base}/api/v2/search/tag/resource.service.name/values`,
        { headers: this._headers() }
      );
      if (!res.ok) return [];
      const body = await res.json();
      const vals = (body && body.tagValues) || [];
      return vals
        .map((v) => (typeof v === "string" ? v : v && v.value))
        .filter(Boolean)
        .map((name) => ({ name, source: this.name, signalType: "metrics" }));
    } catch {
      return [];
    }
  }

  async queryMetrics(params) {
    const known =
      this._metrics.find((m) => m.name === params.metric) ||
      DEFAULT_METRICS.find((m) => m.name === params.metric);
    const def = known || (LATENCY_ALIASES.has(String(params.metric).toLowerCase()) ? DEFAULT_METRICS[0] : null);
    if (!def) throw new Error(`unknown metric '${params.metric}' for tempo (only trace-derived latency is supported)`);
    const { start, end } = parseTimeRange(params.duration);
    const q = def.query.replace(/\$service\b/g, params.service);
    const u = new URL(`${this._base}/api/search`);
    u.searchParams.set("q", q);
    u.searchParams.set("start", String(start));
    u.searchParams.set("end", String(end));
    u.searchParams.set("limit", String(Math.min(params.limit || 200, 1000)));
    const res = await fetch(u, { headers: this._headers() });
    if (!res.ok) throw new Error(`Tempo search HTTP ${res.status}`);
    const body = await res.json();
    const traces = (body && body.traces) || [];
    const dps = traces
      .map((t) => ({
        // Tempo returns startTimeUnixNano as a string; durationMs as a number.
        ts: Number(t.startTimeUnixNano) / 1e6,
        value: Number(t.durationMs) / 1000, // ms → seconds
      }))
      .filter((d) => !Number.isNaN(d.value) && !Number.isNaN(d.ts))
      .sort((a, b) => a.ts - b.ts)
      .map((d) => ({ timestamp: new Date(d.ts).toISOString(), value: d.value }));
    return {
      source: this.name,
      service: params.service,
      metric: params.metric,
      unit: def.unit,
      values: dps,
      summary: summarize(dps.map((d) => d.value)),
      resolvedSeries: q,
    };
  }
}

export default function create() {
  return new TempoConnector();
}
