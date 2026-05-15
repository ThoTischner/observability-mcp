// Grafana connector for observability-mcp. Grafana stores no telemetry
// itself — it proxies to datasources. So this connector is a *gateway*:
// it reaches a Prometheus-compatible datasource (metrics) and a Loki
// datasource (logs) THROUGH Grafana's datasource proxy, behind
// Grafana's auth — one pane, one token.
//
// Standalone dependency-free ESM (Node 20 fetch), duck-typed against
// the ObservabilityConnector contract (no SDK import → self-contained,
// airgapped-mirrorable tarball).
//
// Auth: a Grafana service-account token (Bearer). Datasource UIDs are
// auto-resolved from /api/datasources (first prometheus / first loki),
// overridable via GRAFANA_PROM_DS_UID / GRAFANA_LOKI_DS_UID.

function parseTimeRange(duration) {
  const m = String(duration || "").match(/^(\d+)([mhd])$/);
  if (!m) throw new Error(`invalid duration: ${duration} (use 5m, 1h, 24h)`);
  const n = parseInt(m[1], 10);
  const secs = m[2] === "m" ? n * 60 : m[2] === "h" ? n * 3600 : n * 86400;
  const end = Math.floor(Date.now() / 1000);
  return { start: end - secs, end, stepSec: Math.max(Math.floor(secs / 100), 15) };
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

const DEFAULT_METRICS = [
  { name: "cpu", query: 'rate(process_cpu_seconds_total{service="$service"}[5m])', unit: "percent", description: "CPU seconds rate for the service" },
  { name: "memory", query: 'process_resident_memory_bytes{service="$service"}', unit: "bytes", description: "Resident memory for the service" },
  { name: "latency", query: 'histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{service="$service"}[5m])) by (le))', unit: "seconds", description: "p99 request latency" },
  { name: "errors", query: 'sum(rate(http_requests_total{service="$service",status=~"5.."}[5m]))', unit: "req/s", description: "5xx error rate" },
];

export class GrafanaConnector {
  constructor() {
    this.name = "grafana";
    this.type = "grafana";
    this.signalType = "metrics";
    this._metrics = DEFAULT_METRICS;
    this._base = "";
    this._token = "";
    this._promUid = "";
    this._lokiUid = "";
  }

  async connect(config) {
    this._base = (config && config.url) ? String(config.url).replace(/\/$/, "") : "";
    if (!this._base) throw new Error("Grafana url is required");
    const auth = (config && config.auth) || {};
    this._token = auth.token || process.env.GRAFANA_TOKEN || "";
    if (!this._token) throw new Error("Grafana service-account token missing (source auth bearer token, or GRAFANA_TOKEN)");
    if (Array.isArray(config && config.metrics) && config.metrics.length > 0) {
      this._metrics = config.metrics;
    }
    this._promUid = process.env.GRAFANA_PROM_DS_UID || "";
    this._lokiUid = process.env.GRAFANA_LOKI_DS_UID || "";
    // Auto-resolve datasource UIDs unless pinned via env. Best-effort:
    // a discovery failure must not break connect — explicit env still works.
    if (!this._promUid || !this._lokiUid) {
      try {
        const res = await fetch(`${this._base}/api/datasources`, { headers: this._headers() });
        if (res.ok) {
          const list = await res.json();
          for (const ds of Array.isArray(list) ? list : []) {
            if (!this._promUid && ds.type === "prometheus") this._promUid = ds.uid;
            if (!this._lokiUid && ds.type === "loki") this._lokiUid = ds.uid;
          }
        }
      } catch {
        /* keep env-provided (possibly empty) uids */
      }
    }
  }

  async disconnect() {
    /* stateless */
  }

  _headers() {
    return { Authorization: `Bearer ${this._token}` };
  }

  _proxy(uid, path) {
    return `${this._base}/api/datasources/proxy/uid/${uid}${path}`;
  }

  async healthCheck() {
    const started = Date.now();
    try {
      const res = await fetch(`${this._base}/api/health`, { headers: this._headers() });
      const latencyMs = Date.now() - started;
      if (!res.ok) return { status: "down", latencyMs, message: `health HTTP ${res.status}` };
      const b = await res.json().catch(() => ({}));
      return b && (b.database === "ok" || b.status === "ok")
        ? { status: "up", latencyMs }
        : { status: "down", latencyMs, message: "grafana health not ok" };
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
    if (!this._promUid) return [];
    try {
      const res = await fetch(this._proxy(this._promUid, "/api/v1/label/service/values"), {
        headers: this._headers(),
      });
      if (!res.ok) return [];
      const body = await res.json();
      const vals = (body && body.data) || [];
      return vals.map((name) => ({ name, source: this.name, signalType: "metrics" }));
    } catch {
      return [];
    }
  }

  async queryMetrics(params) {
    if (!this._promUid) throw new Error("no Prometheus datasource resolved (set GRAFANA_PROM_DS_UID)");
    const def = this._metrics.find((m) => m.name === params.metric)
      || DEFAULT_METRICS.find((m) => m.name === params.metric);
    if (!def) throw new Error(`unknown metric '${params.metric}' for grafana`);
    const { start, end, stepSec } = parseTimeRange(params.duration);
    const q = def.query.replace(/\$service\b/g, params.service);
    const u = new URL(this._proxy(this._promUid, "/api/v1/query_range"));
    u.searchParams.set("query", q);
    u.searchParams.set("start", String(start));
    u.searchParams.set("end", String(end));
    u.searchParams.set("step", String(stepSec));
    const res = await fetch(u, { headers: this._headers() });
    if (!res.ok) throw new Error(`Grafana proxy query HTTP ${res.status}`);
    const body = await res.json();
    const result = (body && body.data && body.data.result) || [];
    const series = result[0] || null;
    const dps = ((series && series.values) || [])
      .map((p) => ({ timestamp: new Date(Number(p[0]) * 1000).toISOString(), value: Number(p[1]) }))
      .filter((d) => !Number.isNaN(d.value));
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

  async queryLogs(params) {
    if (!this._lokiUid) throw new Error("no Loki datasource resolved (set GRAFANA_LOKI_DS_UID)");
    const { start, end } = parseTimeRange(params.duration);
    let selector = `{service="${params.service}"}`;
    if (params.level) selector += ` | level="${params.level}"`;
    if (params.query) selector += ` |= "${params.query}"`;
    const u = new URL(this._proxy(this._lokiUid, "/loki/api/v1/query_range"));
    u.searchParams.set("query", selector);
    u.searchParams.set("start", `${start}000000000`);
    u.searchParams.set("end", `${end}000000000`);
    u.searchParams.set("limit", String(Math.min(params.limit || 100, 1000)));
    u.searchParams.set("direction", "backward");
    const res = await fetch(u, { headers: this._headers() });
    if (!res.ok) throw new Error(`Grafana Loki proxy HTTP ${res.status}`);
    const body = await res.json();
    const streams = (body && body.data && body.data.result) || [];
    let errorCount = 0;
    let warnCount = 0;
    const entries = [];
    for (const s of streams) {
      const svc = (s.stream && (s.stream.service || s.stream.app)) || params.service;
      const lvl = (s.stream && (s.stream.level || s.stream.detected_level) || "info").toLowerCase();
      for (const [tsNano, line] of s.values || []) {
        if (lvl === "error" || lvl === "critical") errorCount++;
        else if (lvl === "warn" || lvl === "warning") warnCount++;
        entries.push({
          timestamp: new Date(Number(tsNano) / 1e6).toISOString(),
          level: lvl,
          message: String(line),
          labels: { service: svc },
        });
      }
    }
    return {
      source: this.name,
      service: params.service,
      entries,
      summary: { total: entries.length, errorCount, warnCount, topPatterns: [] },
    };
  }
}

export default function create() {
  return new GrafanaConnector();
}
