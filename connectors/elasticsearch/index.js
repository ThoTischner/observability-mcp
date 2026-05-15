// Elasticsearch connector for observability-mcp. ES is primarily a
// log/document store; this connector exposes logs via _search and
// log-derived metrics via date_histogram aggregations (doc rate,
// error rate, …) so it fits the metrics+logs contract.
//
// Standalone dependency-free ESM (Node 20 fetch), duck-typed against
// the ObservabilityConnector contract — self-contained, airgapped-
// mirrorable tarball.
//
// Auth: API key (Authorization: ApiKey <base64 id:key>) via the source
// bearer token / ES_API_KEY, or HTTP basic (username+password).
// Index pattern via ES_INDEX (default "logs-*"). Assumes ECS-ish
// fields: @timestamp, service.name, log.level, message.

const DEFAULT_METRICS = [
  { name: "log_rate", query: "*", unit: "doc/s", description: "Document (log) rate for the service" },
  { name: "error_rate", query: "log.level:error", unit: "doc/s", description: "Error-level document rate for the service" },
];

function parseTimeRange(duration) {
  const m = String(duration || "").match(/^(\d+)([mhd])$/);
  if (!m) throw new Error(`invalid duration: ${duration} (use 5m, 1h, 24h)`);
  const n = parseInt(m[1], 10);
  const secs = m[2] === "m" ? n * 60 : m[2] === "h" ? n * 3600 : n * 86400;
  const endMs = Date.now();
  return { fromMs: endMs - secs * 1000, toMs: endMs, secs };
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

export class ElasticsearchConnector {
  constructor() {
    this.name = "elasticsearch";
    this.type = "elasticsearch";
    this.signalType = "logs";
    this._metrics = DEFAULT_METRICS;
    this._base = "";
    this._authHeader = "";
    this._index = process.env.ES_INDEX || "logs-*";
  }

  async connect(config) {
    this._base = (config && config.url) ? String(config.url).replace(/\/$/, "") : "";
    if (!this._base) throw new Error("Elasticsearch url is required");
    const auth = (config && config.auth) || {};
    const apiKey = auth.token || process.env.ES_API_KEY || "";
    if (apiKey) {
      this._authHeader = `ApiKey ${apiKey}`;
    } else if (auth.username) {
      const b = Buffer.from(`${auth.username}:${auth.password || ""}`).toString("base64");
      this._authHeader = `Basic ${b}`;
    } else {
      this._authHeader = "";
    }
    if (Array.isArray(config && config.metrics) && config.metrics.length > 0) {
      this._metrics = config.metrics;
    }
  }

  async disconnect() {
    /* stateless */
  }

  _headers() {
    const h = { "Content-Type": "application/json" };
    if (this._authHeader) h.Authorization = this._authHeader;
    return h;
  }

  async _search(body) {
    const res = await fetch(`${this._base}/${encodeURIComponent(this._index)}/_search`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Elasticsearch _search HTTP ${res.status}`);
    return res.json();
  }

  async healthCheck() {
    const started = Date.now();
    try {
      const res = await fetch(`${this._base}/_cluster/health`, { headers: this._headers() });
      const latencyMs = Date.now() - started;
      if (!res.ok) return { status: "down", latencyMs, message: `cluster health HTTP ${res.status}` };
      const b = await res.json().catch(() => ({}));
      return b && (b.status === "green" || b.status === "yellow" || b.status === "red")
        ? { status: b.status === "red" ? "down" : "up", latencyMs, message: `cluster ${b.status}` }
        : { status: "down", latencyMs, message: "unexpected cluster health" };
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

  _range(fromMs, toMs) {
    return { range: { "@timestamp": { gte: new Date(fromMs).toISOString(), lte: new Date(toMs).toISOString() } } };
  }

  async listServices() {
    try {
      const { fromMs, toMs } = parseTimeRange("1h");
      const body = await this._search({
        size: 0,
        query: { bool: { filter: [this._range(fromMs, toMs)] } },
        aggs: { svc: { terms: { field: "service.name", size: 200 } } },
      });
      const buckets = (((body || {}).aggregations || {}).svc || {}).buckets || [];
      return buckets.map((b) => ({ name: String(b.key), source: this.name, signalType: "logs" }));
    } catch {
      return [];
    }
  }

  async queryMetrics(params) {
    const def = this._metrics.find((m) => m.name === params.metric)
      || DEFAULT_METRICS.find((m) => m.name === params.metric);
    if (!def) throw new Error(`unknown metric '${params.metric}' for elasticsearch`);
    const { fromMs, toMs, secs } = parseTimeRange(params.duration);
    const intervalSec = Math.max(Math.floor(secs / 100), 15);
    const filter = [
      { term: { "service.name": params.service } },
      this._range(fromMs, toMs),
    ];
    if (def.query && def.query !== "*") {
      filter.push({ query_string: { query: def.query } });
    }
    const body = await this._search({
      size: 0,
      query: { bool: { filter } },
      aggs: {
        ts: {
          date_histogram: { field: "@timestamp", fixed_interval: `${intervalSec}s`, min_doc_count: 0 },
        },
      },
    });
    const buckets = (((body || {}).aggregations || {}).ts || {}).buckets || [];
    const dps = buckets.map((b) => ({
      timestamp: new Date(b.key).toISOString(),
      value: (b.doc_count || 0) / intervalSec,
    }));
    return {
      source: this.name,
      service: params.service,
      metric: params.metric,
      unit: def.unit,
      values: dps,
      summary: summarize(dps.map((d) => d.value)),
      resolvedSeries: `index=${this._index} q=${def.query}`,
    };
  }

  async queryLogs(params) {
    const { fromMs, toMs } = parseTimeRange(params.duration);
    const filter = [
      { term: { "service.name": params.service } },
      this._range(fromMs, toMs),
    ];
    if (params.level) filter.push({ term: { "log.level": params.level } });
    if (params.query) filter.push({ query_string: { query: params.query } });
    const body = await this._search({
      size: Math.min(params.limit || 100, 1000),
      sort: [{ "@timestamp": "desc" }],
      query: { bool: { filter } },
    });
    const hits = (((body || {}).hits || {}).hits) || [];
    let errorCount = 0;
    let warnCount = 0;
    const entries = hits.map((h) => {
      const s = h._source || {};
      const level = String((s.log && s.log.level) || s["log.level"] || "info").toLowerCase();
      if (level === "error" || level === "fatal" || level === "critical") errorCount++;
      else if (level === "warn" || level === "warning") warnCount++;
      const svc = (s.service && s.service.name) || s["service.name"] || params.service;
      return {
        timestamp: s["@timestamp"] ? new Date(s["@timestamp"]).toISOString() : new Date().toISOString(),
        level,
        message: String(s.message != null ? s.message : ""),
        labels: { service: svc },
      };
    });
    return {
      source: this.name,
      service: params.service,
      entries,
      summary: { total: entries.length, errorCount, warnCount, topPatterns: [] },
    };
  }
}

export default function create() {
  return new ElasticsearchConnector();
}
