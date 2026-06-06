// Istio topology connector for observability-mcp.
//
// Derives a service-graph from Istio's telemetry-v2 Prometheus metric
// `istio_requests_total` — one CALLS edge per observed
// (source_workload, destination_workload) pair, normalised over the
// chosen lookback window. Edge confidence reflects the request volume
// share so a chatty noisy edge ranks above a rare one.
//
// Why Prometheus and not the Istio control-plane API? Two reasons:
//   1. Istio's own istiod doesn't expose a "give me the runtime graph"
//      endpoint — Kiali talks to the same Prometheus we do.
//   2. Every Istio install already ships a Prometheus scrape config; we
//      reuse what the operator already has rather than asking for a
//      new privileged credential.
//
// Auth: optional Bearer token (when the operator fronts Prometheus
// with an auth proxy). Standard HTTP via node-builtin fetch.

const TOPOLOGY_TTL_MS = 30_000;
const DEFAULT_LOOKBACK = "5m";

// Stable resource ids. We scope by namespace + workload so two
// workloads named "checkout" in different namespaces don't collide.
function serviceId(namespace, name) {
  return `istio:service:${namespace || "global"}/${name}`;
}

export class IstioConnector {
  constructor() {
    this.type = "istio";
    this.signalType = "topology";
    this.name = "istio";
    this._base = "";
    this._token = "";
    this._lookback = DEFAULT_LOOKBACK;
    this._snapshot = null;
    this._snapshotExpiresAt = 0;
    this._watchers = new Set();
    this._watchTimer = null;
    this._buildRevision = 0;
    this._fetch = globalThis.fetch;
  }

  async connect(config) {
    this.name = config.name || "istio";
    if (!config.url) throw new Error("istio connector: url is required (Prometheus base URL)");
    this._base = String(config.url).replace(/\/+$/, "");
    // Auth: source token (from sources.yaml `auth.token`) wins over
    // ISTIO_PROM_TOKEN env. Operators wiring through a sealed-secret
    // typically use the env path.
    this._token =
      config.auth?.token ||
      config.token ||
      process.env.ISTIO_PROM_TOKEN ||
      "";
    this._lookback = config.lookback || DEFAULT_LOOKBACK;
    // Test path: inject a custom fetch.
    if (config._fetch) this._fetch = config._fetch;
  }

  async healthCheck() {
    const t0 = Date.now();
    try {
      const u = new URL(`${this._base}/api/v1/query`);
      u.searchParams.set("query", "up");
      const res = await this._fetch(u, { headers: this._headers() });
      if (!res.ok) {
        return { status: "down", latencyMs: Date.now() - t0, message: `prom HTTP ${res.status}` };
      }
      return { status: "up", latencyMs: Date.now() - t0 };
    } catch (err) {
      return {
        status: "down",
        latencyMs: Date.now() - t0,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async disconnect() {
    if (this._watchTimer) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
    }
    this._watchers.clear();
    this._snapshot = null;
  }

  getDefaultMetrics() { return []; }
  getMetrics() { return []; }

  async listServices() {
    const snap = await this._refreshIfStale();
    return snap.resources
      .filter((r) => r.kind === "service_mesh_service")
      .map((r) => ({ name: r.name, source: this.name, signals: ["topology"] }));
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
    queueMicrotask(async () => {
      try {
        const snap = await this._refreshIfStale();
        listener({ type: "resync", snapshot: snap });
      } catch { /* swallow */ }
    });
    if (!this._watchTimer) {
      this._watchTimer = setInterval(async () => {
        let snap;
        try { snap = await this._buildSnapshot(); } catch { return; }
        this._snapshot = snap;
        this._snapshotExpiresAt = Date.now() + TOPOLOGY_TTL_MS;
        for (const l of this._watchers) {
          try { l({ type: "resync", snapshot: snap }); } catch { /* skip */ }
        }
      }, TOPOLOGY_TTL_MS);
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

  // --- internals ------------------------------------------------------

  _headers() {
    const h = { Accept: "application/json" };
    if (this._token) h.Authorization = `Bearer ${this._token}`;
    return h;
  }

  async _refreshIfStale() {
    const now = Date.now();
    if (this._snapshot && now < this._snapshotExpiresAt) return this._snapshot;
    const snap = await this._buildSnapshot();
    this._snapshot = snap;
    this._snapshotExpiresAt = now + TOPOLOGY_TTL_MS;
    return snap;
  }

  async _buildSnapshot() {
    // Aggregate istio_requests_total over the lookback. Group by the
    // (source_workload, source_workload_namespace, destination_workload,
    // destination_workload_namespace) tuple; sum the counter increment
    // over the window so the resulting value is "requests in window".
    const lookback = this._lookback;
    const query = `sum by (source_workload, source_workload_namespace, destination_workload, destination_workload_namespace) (increase(istio_requests_total[${lookback}]))`;
    const u = new URL(`${this._base}/api/v1/query`);
    u.searchParams.set("query", query);
    const res = await this._fetch(u, { headers: this._headers() });
    if (!res.ok) throw new Error(`istio prom query HTTP ${res.status}`);
    const body = await res.json();
    const samples = body?.data?.result || [];

    // Build a service-name → resource map (namespace + name uniquely
    // identify a workload). canonicalName goes onto the resource so
    // mergeTopologies collapses the same name from k8s + tempo + the
    // service-mesh.
    const services = new Map();
    const self = this;
    const ensure = (ns, name) => {
      if (!name || name === "unknown") return null;
      const k = `${ns || "global"}/${name}`;
      let r = services.get(k);
      if (!r) {
        r = {
          id: serviceId(ns, name),
          kind: "service_mesh_service",
          name,
          source: self.name,
          labels: { namespace: ns || "global", mesh: "istio" },
          attributes: { provider: "istio", canonicalName: String(name).toLowerCase() },
        };
        services.set(k, r);
      }
      return r;
    };

    // Aggregate edge weights so we can normalise confidence.
    const edgeMap = new Map();
    let maxWeight = 0;
    for (const s of samples) {
      const sNs = s.metric?.source_workload_namespace;
      const sName = s.metric?.source_workload;
      const dNs = s.metric?.destination_workload_namespace;
      const dName = s.metric?.destination_workload;
      const value = Number(s.value?.[1]);
      if (!Number.isFinite(value) || value <= 0) continue;
      const src = ensure(sNs, sName);
      const dst = ensure(dNs, dName);
      if (!src || !dst || src.id === dst.id) continue;
      const key = `${src.id}|${dst.id}`;
      const prev = edgeMap.get(key) || { from: src.id, to: dst.id, weight: 0 };
      prev.weight += value;
      edgeMap.set(key, prev);
      if (prev.weight > maxWeight) maxWeight = prev.weight;
    }

    const edges = [];
    for (const e of edgeMap.values()) {
      const ratio = maxWeight > 0 ? e.weight / maxWeight : 0;
      // Confidence stays in [0.5, 1.0] so even rare edges register —
      // the relative weight is in the label for ranking.
      const confidence = 0.5 + 0.5 * ratio;
      edges.push({
        from: e.from,
        to: e.to,
        relation: "CALLS",
        confidence,
        attributes: { requests_in_window: e.weight, lookback: this._lookback },
      });
    }

    this._buildRevision += 1;
    return {
      source: this.name,
      resources: [...services.values()],
      edges,
      revision: this._buildRevision,
    };
  }
}

export default function create() {
  return new IstioConnector();
}
