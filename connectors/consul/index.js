// Consul topology connector for observability-mcp.
//
// Reads Consul Connect's service-graph from the Consul HTTP API:
//
//   GET /v1/catalog/services        → discover every registered
//                                      service name.
//   GET /v1/connect/intentions/match → list the inbound intentions
//                                      (CALLS edges) for each service.
//   GET /v1/health/service/<name>    → instance count (label) + a
//                                      stable list of nodes.
//
// Auth: optional X-Consul-Token header. Standard HTTP — globalThis.fetch.
//
// Same dependency-free pattern as Istio + Linkerd (no SDK to lazy-load).

const TOPOLOGY_TTL_MS = 30_000;
const MAX_INTENTIONS_PARALLEL = 8;
const HEALTH_FETCH_CAP = 50;

function serviceId(dc, name) {
  return `consul:service:${dc || "global"}/${name}`;
}

export class ConsulConnector {
  constructor() {
    this.type = "consul";
    this.signalType = "topology";
    this.name = "consul";
    this._base = "";
    this._token = "";
    this._datacenter = "";
    this._snapshot = null;
    this._snapshotExpiresAt = 0;
    this._watchers = new Set();
    this._watchTimer = null;
    this._buildRevision = 0;
    this._fetch = globalThis.fetch;
  }

  async connect(config) {
    this.name = config.name || "consul";
    if (!config.url) throw new Error("consul connector: url is required");
    this._base = String(config.url).replace(/\/+$/, "");
    this._token =
      config.auth?.token ||
      config.token ||
      process.env.CONSUL_HTTP_TOKEN ||
      "";
    this._datacenter = config.datacenter || process.env.CONSUL_DATACENTER || "";
    if (config._fetch) this._fetch = config._fetch;
  }

  async healthCheck() {
    const t0 = Date.now();
    try {
      const u = new URL(`${this._base}/v1/status/leader`);
      const res = await this._fetch(u, { headers: this._headers() });
      if (!res.ok) {
        return { status: "down", latencyMs: Date.now() - t0, message: `consul HTTP ${res.status}` };
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

  async listResources() { return (await this._refreshIfStale()).resources; }
  async listEdges() { return (await this._refreshIfStale()).edges; }
  async getTopologySnapshot() { return this._refreshIfStale(); }

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
    if (this._token) h["X-Consul-Token"] = this._token;
    return h;
  }

  async _buildSnapshot() {
    const dc = this._datacenter;
    // 1. /v1/catalog/services returns { name: [tag1, tag2, ...] }.
    //    Filter the consul-internal "consul" service out — it's not
    //    interesting for blast-radius reasoning.
    const catalogUrl = new URL(`${this._base}/v1/catalog/services`);
    if (dc) catalogUrl.searchParams.set("dc", dc);
    const catRes = await this._fetch(catalogUrl, { headers: this._headers() });
    if (!catRes.ok) throw new Error(`consul catalog HTTP ${catRes.status}`);
    const catBody = await catRes.json();
    const allServices = Object.keys(catBody || {}).filter((n) => n && n !== "consul");

    // 2. Instance counts via /v1/health/service/<name>. Capped so a
    //    large catalog doesn't trigger one fetch per service.
    const healthMap = new Map();
    const healthBudget = Math.min(allServices.length, HEALTH_FETCH_CAP);
    for (let i = 0; i < healthBudget; i++) {
      const svc = allServices[i];
      try {
        const u = new URL(`${this._base}/v1/health/service/${encodeURIComponent(svc)}`);
        if (dc) u.searchParams.set("dc", dc);
        const r = await this._fetch(u, { headers: this._headers() });
        if (!r.ok) continue;
        const body = await r.json();
        healthMap.set(svc, Array.isArray(body) ? body.length : 0);
      } catch { /* skip */ }
    }

    // 3. Inbound intentions per service (the CALLS-into edges).
    //    Match endpoint returns { Matches: { "<svc>": [intention, ...] } }.
    //    We chunk requests so a 200-service catalog doesn't hammer
    //    Consul with one connection per service.
    const edgeMap = new Map();
    const queue = allServices.slice();
    while (queue.length) {
      const batch = queue.splice(0, MAX_INTENTIONS_PARALLEL);
      await Promise.all(batch.map(async (svc) => {
        try {
          const u = new URL(`${this._base}/v1/connect/intentions/match`);
          u.searchParams.set("by", "destination");
          u.searchParams.set("name", svc);
          if (dc) u.searchParams.set("dc", dc);
          const r = await this._fetch(u, { headers: this._headers() });
          if (!r.ok) return;
          const body = await r.json();
          const list = body?.[svc] || [];
          for (const intent of list) {
            const srcName = intent.SourceName;
            if (!srcName || srcName === "*" || srcName === svc) continue;
            const key = `${srcName}|${svc}`;
            if (!edgeMap.has(key)) {
              edgeMap.set(key, {
                from: serviceId(dc, srcName),
                to: serviceId(dc, svc),
                relation: "CALLS",
                confidence: intent.Action === "allow" ? 1.0 : 0.5,
                attributes: {
                  intent_id: intent.ID || "",
                  action: intent.Action || "",
                },
              });
            }
          }
        } catch { /* skip */ }
      }));
    }

    // 4. Materialise resources. Every service mentioned in either the
    //    catalog OR as an intention source becomes a node.
    const seen = new Set(allServices);
    for (const e of edgeMap.values()) {
      const srcShort = e.from.split("/").pop();
      const dstShort = e.to.split("/").pop();
      seen.add(srcShort);
      seen.add(dstShort);
    }
    const resources = [];
    for (const name of seen) {
      if (name === "consul") continue;
      resources.push({
        id: serviceId(dc, name),
        kind: "service_mesh_service",
        name,
        source: this.name,
        labels: {
          datacenter: dc || "global",
          mesh: "consul",
          instances: String(healthMap.get(name) ?? 0),
        },
        attributes: { provider: "consul", canonicalName: name.toLowerCase() },
      });
    }
    const edges = [...edgeMap.values()];

    this._buildRevision += 1;
    return { source: this.name, resources, edges, revision: this._buildRevision };
  }

  async _refreshIfStale() {
    const now = Date.now();
    if (this._snapshot && now < this._snapshotExpiresAt) return this._snapshot;
    const snap = await this._buildSnapshot();
    this._snapshot = snap;
    this._snapshotExpiresAt = now + TOPOLOGY_TTL_MS;
    return snap;
  }
}

export default function create() {
  return new ConsulConnector();
}
