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

// Topology cache TTL — Tempo trace data lags real-world calls by tens of
// seconds anyway, so refreshing more often just burns Tempo API quota.
const TOPOLOGY_TTL_MS = 30_000;
// How many recent traces we sample per refresh. Larger = better edge
// coverage but more /api/traces round-trips. 50 is a defensible compromise
// for demos and CI; operators can override via source config.
const DEFAULT_TRACE_SAMPLE = 50;
// Inferred trace-derived edges carry lower confidence than authoritative
// k8s ownerReferences edges (1.0). Documented in topology-vocabulary.md.
const CALLS_CONFIDENCE = 0.7;

export class TempoConnector {
  constructor() {
    this.name = "tempo";
    this.type = "tempo";
    // Honest reporting: we now emit both — metrics (trace-derived latency)
    // AND topology (service graph from trace spans). The connector
    // surface in interface.ts inspects the topology methods, not this
    // string; `signalType` stays informational.
    this.signalType = "metrics";
    this._metrics = DEFAULT_METRICS;
    this._base = "";
    this._token = "";
    this._traceSample = DEFAULT_TRACE_SAMPLE;
    // Memoized topology snapshot — built lazily, refreshed on demand.
    this._topology = { snap: null, expiresAt: 0, revision: 0 };
    this._watchers = new Set();
    this._watchTimer = null;
  }

  async connect(config) {
    this._base = config && config.url ? String(config.url).replace(/\/$/, "") : "";
    if (!this._base) throw new Error("Tempo url is required");
    const auth = (config && config.auth) || {};
    this._token = auth.token || process.env.TEMPO_TOKEN || "";
    if (Array.isArray(config && config.metrics) && config.metrics.length > 0) {
      this._metrics = config.metrics;
    }
    const sample = config && Number(config.traceSample);
    if (Number.isFinite(sample) && sample > 0) {
      this._traceSample = Math.min(Math.floor(sample), 500);
    }
  }

  async disconnect() {
    if (this._watchTimer) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
    }
    this._watchers.clear();
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

  // --- Traces capability (P3 of production-readiness sprint) ---
  //
  // Returns ranked TraceSpanSummary[] for a given service + window
  // — the shape the gateway's `query_traces` MCP tool merges across
  // every traces-capable connector. We hit Tempo's /api/search with
  // a TraceQL query (default `{ resource.service.name="X" }`,
  // overridable via params.filter), then for each returned trace
  // optionally fetch the full trace via /api/traces/:id to compute
  // spanCount + hasError. The full-trace fan-out is gated on a
  // per-call budget so a 1000-trace search doesn't trigger 1000
  // upstream fetches.
  async queryTraces(params) {
    const service = params && params.service;
    if (!service) throw new Error("queryTraces: service is required");
    const limit = Math.max(1, Math.min(Number(params.limit) || 50, 200));
    const { start, end } = parseTimeRange(params.duration || "15m");
    // Build the TraceQL query. If the caller passed a backend-
    // native filter we substitute the service automatically when
    // they didn't include it themselves.
    let q = (params.filter && String(params.filter).trim()) || "";
    if (!q) {
      q = `{ resource.service.name="${escapeTraceQL(service)}" }`;
    } else if (!q.includes("resource.service.name")) {
      // Best-effort: AND the service constraint in. If the user's
      // filter is already wrapped in `{}` we splice; otherwise pass
      // through and trust them.
      const trimmed = q.trim();
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        const inner = trimmed.slice(1, -1).trim();
        q = `{ resource.service.name="${escapeTraceQL(service)}" && ${inner} }`;
      }
    }
    const u = new URL(`${this._base}/api/search`);
    u.searchParams.set("q", q);
    u.searchParams.set("start", String(start));
    u.searchParams.set("end", String(end));
    u.searchParams.set("limit", String(limit));
    const res = await fetch(u, { headers: this._headers() });
    if (!res.ok) {
      throw new Error(`Tempo /api/search HTTP ${res.status}`);
    }
    const body = await res.json();
    const raw = (body && body.traces) || [];

    // Best-effort spanCount + hasError enrichment. Cap at 25
    // per-call so a noisy search doesn't multiply the upstream
    // load. The unenriched traces still come back with the
    // metadata search alone provides.
    const TRACE_FETCH_CAP = 25;
    const enriched = [];
    for (let i = 0; i < raw.length; i++) {
      const t = raw[i] || {};
      const traceId = t.traceID || t.traceId;
      if (!traceId) continue;
      const startMs = Number(t.startTimeUnixNano) / 1e6;
      const durationMs = Number(t.durationMs);
      const rootName = String(t.rootTraceName || t.rootName || "");
      const rootService = String(t.rootServiceName || t.rootService || service);
      let spanCount = Number(t.spanCount) || 0;
      let hasError = Boolean(t.error || t.hasError);
      // Pull full trace for the first N to compute spanCount +
      // error status when the search response doesn't include them.
      if (i < TRACE_FETCH_CAP && (!spanCount || hasError === false)) {
        try {
          const full = await this._fetchTrace(traceId);
          const counts = countSpansAndErrors(full);
          if (counts.spanCount) spanCount = counts.spanCount;
          if (counts.hasError) hasError = true;
        } catch {
          /* leave fields as-is */
        }
      }
      enriched.push({
        traceId,
        rootName: rootName || "(unknown)",
        rootService,
        durationMs: Number.isFinite(durationMs) ? durationMs : 0,
        spanCount,
        hasError,
        startTs: Number.isFinite(startMs) ? new Date(startMs).toISOString() : new Date().toISOString(),
      });
    }
    // Optional client-side errorsOnly filter; the API doesn't gate
    // by error directly.
    const final = params.errorsOnly ? enriched.filter((t) => t.hasError) : enriched;
    const durations = final.map((t) => t.durationMs).sort((a, b) => a - b);
    const p = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : 0);
    return {
      source: this.name,
      service,
      traces: final,
      summary: {
        total: final.length,
        errorCount: final.filter((t) => t.hasError).length,
        p50DurationMs: p(durations, 0.5),
        p95DurationMs: p(durations, 0.95),
      },
    };
  }

  // --- Topology capability ---
  //
  // Tempo does not expose a service-graph endpoint directly — what it
  // exposes is the raw trace store. We derive the service graph the same
  // way Grafana's "Service Graph" tab does client-side: sample N recent
  // traces, walk the span tree, and for every parent → child span pair
  // where the resource.service.name differs, emit one CALLS edge. Edges
  // are de-duplicated across the sample so a chatty path does not produce
  // N copies.
  //
  // This is a sampled, eventually-consistent view — confidence < 1.0 on
  // every edge. See docs/topology-vocabulary.md for the meaning of CALLS
  // and the confidence convention.

  async _buildTopology() {
    const services = await this.listServices();
    const resources = services.map((s) => ({
      id: serviceId(s.name),
      kind: "service",
      name: s.name,
      source: this.name,
      labels: {},
      attributes: {},
    }));
    const edgeMap = new Map();
    let traceIds;
    try {
      traceIds = await this._sampleTraceIds();
    } catch {
      traceIds = [];
    }
    for (const id of traceIds) {
      let trace;
      try {
        trace = await this._fetchTrace(id);
      } catch {
        continue;
      }
      for (const [from, to] of callPairs(trace)) {
        if (!from || !to || from === to) continue;
        const key = `${from}|${to}`;
        if (edgeMap.has(key)) continue;
        edgeMap.set(key, {
          from: serviceId(from),
          to: serviceId(to),
          relation: "CALLS",
          source: this.name,
          confidence: CALLS_CONFIDENCE,
        });
      }
    }
    // Make sure every endpoint of an edge appears as a resource — a service
    // discovered only via a trace span (never returned by listServices)
    // would otherwise produce a dangling edge that get_topology strips.
    const have = new Set(resources.map((r) => r.id));
    for (const e of edgeMap.values()) {
      for (const id of [e.from, e.to]) {
        if (have.has(id)) continue;
        have.add(id);
        const name = id.replace(/^tempo:service:/, "");
        resources.push({ id, kind: "service", name, source: this.name, labels: {}, attributes: {} });
      }
    }
    this._topology.revision += 1;
    return {
      source: this.name,
      resources,
      edges: [...edgeMap.values()],
      revision: this._topology.revision,
    };
  }

  async _refreshIfStale() {
    const now = Date.now();
    if (this._topology.snap && now < this._topology.expiresAt) return this._topology.snap;
    const snap = await this._buildTopology();
    this._topology.snap = snap;
    this._topology.expiresAt = now + TOPOLOGY_TTL_MS;
    return snap;
  }

  async _sampleTraceIds() {
    const u = new URL(`${this._base}/api/search`);
    u.searchParams.set("q", "{}");
    u.searchParams.set("limit", String(this._traceSample));
    const res = await fetch(u, { headers: this._headers() });
    if (!res.ok) return [];
    const body = await res.json();
    const traces = (body && body.traces) || [];
    return traces.map((t) => t && (t.traceID || t.traceId)).filter(Boolean);
  }

  async _fetchTrace(id) {
    const res = await fetch(`${this._base}/api/traces/${encodeURIComponent(id)}`, {
      headers: this._headers(),
    });
    if (!res.ok) return null;
    return res.json();
  }

  async listResources() {
    return (await this._refreshIfStale()).resources;
  }

  async listEdges() {
    return (await this._refreshIfStale()).edges;
  }

  async getTopologySnapshot() {
    return this._refreshIfStale();
  }

  watchTopology(listener) {
    this._watchers.add(listener);
    // Initial resync so subscribers see the current state without racing
    // the next poll tick — same contract as the k8s connector.
    queueMicrotask(async () => {
      try {
        const snap = await this._refreshIfStale();
        listener({ type: "resync", snapshot: snap });
      } catch { /* swallow */ }
    });
    if (!this._watchTimer) {
      this._watchTimer = setInterval(async () => {
        let snap;
        try { snap = await this._buildTopology(); } catch { return; }
        this._topology.snap = snap;
        this._topology.expiresAt = Date.now() + TOPOLOGY_TTL_MS;
        for (const l of this._watchers) {
          try { l({ type: "resync", snapshot: snap }); } catch { /* skip */ }
        }
      }, TOPOLOGY_TTL_MS);
      // Don't keep the event loop alive just for this poller.
      if (this._watchTimer && typeof this._watchTimer.unref === "function") {
        this._watchTimer.unref();
      }
    }
    return () => {
      this._watchers.delete(listener);
      if (this._watchers.size === 0 && this._watchTimer) {
        clearInterval(this._watchTimer);
        this._watchTimer = null;
      }
    };
  }
}

// Escape a TraceQL string-literal value. TraceQL string syntax is
// `"…"` with backslash escapes for `\` and `"`. We don't need full
// grammar coverage — just the two characters that would break out
// of the literal.
function escapeTraceQL(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Walk a Tempo /api/traces/:id response and count spans + detect
// any error-status span. The Tempo trace API returns OTLP-shaped
// JSON: { batches: [ { scopeSpans: [ { spans: [...] } ] } ] }. Each
// span has status.code (1=OK, 2=ERROR per OTel) and a name. We're
// conservative — unknown shapes return {spanCount:0, hasError:false}
// rather than throwing.
function countSpansAndErrors(trace) {
  if (!trace || typeof trace !== "object") return { spanCount: 0, hasError: false };
  let spanCount = 0;
  let hasError = false;
  const batches = trace.batches || trace.resourceSpans || [];
  for (const b of batches) {
    const scopes = b.scopeSpans || b.instrumentationLibrarySpans || [];
    for (const s of scopes) {
      const spans = s.spans || [];
      spanCount += spans.length;
      for (const sp of spans) {
        const code = sp && sp.status && (sp.status.code !== undefined ? sp.status.code : sp.status.Code);
        if (code === 2 || code === "STATUS_CODE_ERROR") {
          hasError = true;
        }
      }
    }
  }
  return { spanCount, hasError };
}

function serviceId(name) {
  return `tempo:service:${name}`;
}

// Walk an OTLP-JSON trace and return [parentService, childService] pairs
// for every cross-service span edge. Handles both Tempo response shapes:
// `{batches:[...]}` (newer) and `{trace:{batches:[...]}}` (older wrapper).
function callPairs(trace) {
  const batches = (trace && (trace.batches || (trace.trace && trace.trace.batches))) || [];
  // Build spanId → serviceName once across all batches.
  const svcOf = new Map();
  const spans = [];
  for (const b of batches) {
    const svc = serviceNameOf(b && b.resource);
    if (!svc) continue;
    const scopes = (b && b.scopeSpans) || (b && b.instrumentationLibrarySpans) || [];
    for (const sc of scopes) {
      for (const s of sc.spans || []) {
        if (!s || !s.spanId) continue;
        svcOf.set(s.spanId, svc);
        spans.push(s);
      }
    }
  }
  const pairs = [];
  for (const s of spans) {
    const child = svcOf.get(s.spanId);
    const parentId = s.parentSpanId || s.parentSpanID;
    if (!parentId) continue;
    const parent = svcOf.get(parentId);
    if (!parent || !child || parent === child) continue;
    pairs.push([parent, child]);
  }
  return pairs;
}

function serviceNameOf(resource) {
  const attrs = (resource && resource.attributes) || [];
  for (const a of attrs) {
    if (!a || a.key !== "service.name") continue;
    const v = a.value;
    if (!v) continue;
    return v.stringValue || (typeof v === "string" ? v : null);
  }
  return null;
}

export default function create() {
  return new TempoConnector();
}
