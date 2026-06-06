// Linkerd topology connector for observability-mcp.
//
// Derives a service-graph from Linkerd's `response_total` Prometheus
// metric (emitted by the linkerd-proxy sidecars). Each unique
// (deployment, dst_deployment) pair becomes a CALLS edge in the
// returned topology.
//
// Why the proxy metric and not the linkerd-viz API? Same reasoning
// as the Istio connector — Linkerd installs ship Prometheus, the
// viz `/api/edges` endpoint is itself backed by Prometheus, and
// reusing what the operator already has avoids a new privileged
// credential.
//
// Auth: optional Bearer token for environments that front Prometheus
// with an auth proxy.

const TOPOLOGY_TTL_MS = 30_000;
const DEFAULT_LOOKBACK = "5m";

function serviceId(namespace, name) {
  return `linkerd:service:${namespace || "global"}/${name}`;
}

export class LinkerdConnector {
  constructor() {
    this.type = "linkerd";
    this.signalType = "topology";
    this.name = "linkerd";
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
    this.name = config.name || "linkerd";
    if (!config.url) throw new Error("linkerd connector: url is required (Prometheus base URL)");
    this._base = String(config.url).replace(/\/+$/, "");
    this._token =
      config.auth?.token ||
      config.token ||
      process.env.LINKERD_PROM_TOKEN ||
      "";
    this._lookback = config.lookback || DEFAULT_LOOKBACK;
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
    // Linkerd's outbound proxy metric: response_total grouped by
    // (deployment, namespace, dst_deployment, dst_namespace). We
    // increase() over the window so the result is "responses in
    // window" — the volume share derives edge confidence the same
    // way Istio's connector does.
    const lookback = this._lookback;
    const query = `sum by (deployment, namespace, dst_deployment, dst_namespace) (increase(response_total{direction="outbound"}[${lookback}]))`;
    const u = new URL(`${this._base}/api/v1/query`);
    u.searchParams.set("query", query);
    const res = await this._fetch(u, { headers: this._headers() });
    if (!res.ok) throw new Error(`linkerd prom query HTTP ${res.status}`);
    const body = await res.json();
    const samples = body?.data?.result || [];

    const services = new Map();
    const self = this;
    const ensure = (ns, name) => {
      if (!name) return null;
      const k = `${ns || "global"}/${name}`;
      let r = services.get(k);
      if (!r) {
        r = {
          id: serviceId(ns, name),
          kind: "service_mesh_service",
          name,
          source: self.name,
          labels: { namespace: ns || "global", mesh: "linkerd" },
          attributes: { provider: "linkerd", canonicalName: String(name).toLowerCase() },
        };
        services.set(k, r);
      }
      return r;
    };

    const edgeMap = new Map();
    let maxWeight = 0;
    for (const s of samples) {
      const sNs = s.metric?.namespace;
      const sName = s.metric?.deployment;
      const dNs = s.metric?.dst_namespace;
      const dName = s.metric?.dst_deployment;
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
      const confidence = 0.5 + 0.5 * ratio;
      edges.push({
        from: e.from,
        to: e.to,
        relation: "CALLS",
        confidence,
        attributes: { responses_in_window: e.weight, lookback: this._lookback },
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
  return new LinkerdConnector();
}
