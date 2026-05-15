// Datadog connector for observability-mcp — the first optional,
// hub-distributable connector. Standalone ESM, zero dependencies
// (Node 20+ global fetch), so it ships as a self-contained tarball and
// runs airgapped once mirrored.
//
// Implements the structural ObservabilityConnector contract (duck-typed
// by the server's PluginLoader — no SDK import needed).
//
// Auth: Datadog needs TWO keys. Map them onto SourceConfig as basic
// auth — username = API key, password = Application key — or fall back
// to DD_API_KEY / DD_APP_KEY env vars (handy behind an egress proxy).

const DEFAULT_SITE = "https://api.datadoghq.com";

function parseTimeRange(duration) {
  const m = String(duration || "").match(/^(\d+)([mhd])$/);
  if (!m) throw new Error(`invalid duration: ${duration} (use 5m, 1h, 24h)`);
  const n = parseInt(m[1], 10);
  const secs = m[2] === "m" ? n * 60 : m[2] === "h" ? n * 3600 : n * 86400;
  const end = Math.floor(Date.now() / 1000);
  return { from: end - secs, to: end };
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
  { name: "cpu", query: "avg:system.cpu.user{service:$service}", unit: "percent", description: "CPU user time for the service" },
  { name: "memory", query: "avg:system.mem.used{service:$service}", unit: "bytes", description: "Used memory for the service" },
  { name: "latency", query: "avg:trace.http.request.duration{service:$service}", unit: "seconds", description: "APM request latency (p50 avg)" },
  { name: "errors", query: "sum:trace.http.request.errors{service:$service}.as_count()", unit: "count", description: "APM request error count" },
];

export class DatadogConnector {
  constructor() {
    this.name = "datadog";
    this.type = "datadog";
    this.signalType = "metrics";
    this._metrics = DEFAULT_METRICS;
    this._base = DEFAULT_SITE;
    this._apiKey = "";
    this._appKey = "";
  }

  async connect(config) {
    // config.url may be a full API base (e.g. https://api.datadoghq.eu).
    this._base = (config && config.url) ? String(config.url).replace(/\/$/, "") : DEFAULT_SITE;
    const auth = (config && config.auth) || {};
    this._apiKey = auth.username || process.env.DD_API_KEY || "";
    this._appKey = auth.password || process.env.DD_APP_KEY || "";
    if (Array.isArray(config && config.metrics) && config.metrics.length > 0) {
      this._metrics = config.metrics;
    }
    if (!this._apiKey) {
      throw new Error("Datadog API key missing (set source auth username = API key, or DD_API_KEY)");
    }
  }

  async disconnect() {
    /* stateless: nothing to tear down */
  }

  _headers(needsApp) {
    const h = { "DD-API-KEY": this._apiKey };
    if (needsApp && this._appKey) h["DD-APPLICATION-KEY"] = this._appKey;
    return h;
  }

  async healthCheck() {
    const started = Date.now();
    try {
      const res = await fetch(`${this._base}/api/v1/validate`, { headers: this._headers(false) });
      const latencyMs = Date.now() - started;
      if (!res.ok) return { status: "down", latencyMs, message: `validate HTTP ${res.status}` };
      const body = await res.json().catch(() => ({}));
      return body && body.valid
        ? { status: "up", latencyMs }
        : { status: "down", latencyMs, message: "API key rejected" };
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

  async _query(q, from, to) {
    const u = new URL(`${this._base}/api/v1/query`);
    u.searchParams.set("from", String(from));
    u.searchParams.set("to", String(to));
    u.searchParams.set("query", q);
    const res = await fetch(u, { headers: this._headers(true) });
    if (!res.ok) throw new Error(`Datadog query HTTP ${res.status}`);
    return res.json();
  }

  async listServices() {
    // Derive services from a broad metric grouped by the service tag.
    // Best-effort: never throw — discovery failure shouldn't break the
    // server, the user can still query by explicit service name.
    try {
      const { from, to } = parseTimeRange("1h");
      const body = await this._query("avg:system.cpu.user{*} by {service}", from, to);
      const names = new Set();
      for (const s of (body && body.series) || []) {
        const scope = String(s.scope || "");
        const m = scope.match(/service:([^,]+)/);
        if (m) names.add(m[1]);
      }
      return [...names].map((name) => ({
        name,
        source: this.name,
        signalType: "metrics",
      }));
    } catch {
      return [];
    }
  }

  async queryMetrics(params) {
    const def = this._metrics.find((m) => m.name === params.metric)
      || DEFAULT_METRICS.find((m) => m.name === params.metric);
    if (!def) throw new Error(`unknown metric '${params.metric}' for datadog`);
    const { from, to } = parseTimeRange(params.duration);
    const q = def.query.replace(/\$service\b/g, params.service);
    const body = await this._query(q, from, to);
    const series = (body && body.series && body.series[0]) || null;
    const points = (series && series.pointlist) || [];
    const dps = points
      .filter((p) => Array.isArray(p) && p[1] != null && !Number.isNaN(p[1]))
      .map((p) => ({
        // Datadog pointlist timestamps are epoch milliseconds.
        timestamp: new Date(p[0]).toISOString(),
        value: Number(p[1]),
      }));
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
    const { from, to } = parseTimeRange(params.duration);
    const filterParts = [`service:${params.service}`];
    if (params.level) filterParts.push(`status:${params.level}`);
    if (params.query) filterParts.push(params.query);
    const res = await fetch(`${this._base}/api/v2/logs/events/search`, {
      method: "POST",
      headers: { ...this._headers(true), "Content-Type": "application/json" },
      body: JSON.stringify({
        filter: {
          query: filterParts.join(" "),
          from: `${from}000`,
          to: `${to}000`,
        },
        page: { limit: Math.min(params.limit || 100, 1000) },
        sort: "-timestamp",
      }),
    });
    if (!res.ok) throw new Error(`Datadog logs HTTP ${res.status}`);
    const body = await res.json();
    const events = (body && body.data) || [];
    let errorCount = 0;
    let warnCount = 0;
    const entries = events.map((ev) => {
      const a = (ev && ev.attributes) || {};
      const level = String(a.status || "info").toLowerCase();
      if (level === "error" || level === "critical" || level === "emergency") errorCount++;
      else if (level === "warn" || level === "warning") warnCount++;
      return {
        timestamp: a.timestamp ? new Date(a.timestamp).toISOString() : new Date().toISOString(),
        level,
        message: String(a.message || ""),
        labels: { service: (a.service || params.service) },
      };
    });
    return {
      source: this.name,
      service: params.service,
      entries,
      summary: {
        total: entries.length,
        errorCount,
        warnCount,
        topPatterns: [],
      },
    };
  }
}

export default function create() {
  return new DatadogConnector();
}
