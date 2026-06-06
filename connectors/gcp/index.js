// GCP topology connector for observability-mcp.
//
// Surfaces three Google Cloud surfaces as a unified topology graph:
//
//   - Compute Engine instances → kind "cloud_node"
//   - Cloud Run services        → kind "cloud_service"
//   - GKE clusters + nodepools  → kind "cloud_cluster" + "cloud_node"
//
// Auth: standard Application Default Credentials chain (env, gcloud
// CLI, attached service account). Same SDK-lazy-load pattern as the
// AWS connector — the loader smoke runs each plugin outside an
// `npm install` boundary, so heavy imports must defer until connect()
// AND must surface a structured "down" healthCheck when the SDK
// can't be required at runtime.

let _sdk = null;
async function loadSdk() {
  if (_sdk) return _sdk;
  const [compute, run, container] = await Promise.all([
    import("@google-cloud/compute"),
    import("@google-cloud/run"),
    import("@google-cloud/container"),
  ]);
  _sdk = {
    InstancesClient: compute.InstancesClient,
    ServicesClient: run.ServicesClient,
    ClusterManagerClient: container.ClusterManagerClient,
  };
  return _sdk;
}

const SNAPSHOT_TTL_MS = 30_000;

const id = {
  gce: (project, zone, name) => `gcp:gce:${project}:${zone}/${name}`,
  cloudRun: (project, region, name) => `gcp:cloud-run:${project}:${region}/${name}`,
  gkeCluster: (project, location, name) => `gcp:gke-cluster:${project}:${location}/${name}`,
  gkeNodepool: (project, location, cluster, np) => `gcp:gke-nodepool:${project}:${location}/${cluster}/${np}`,
};

export class GcpConnector {
  constructor() {
    this.type = "gcp";
    this.signalType = "topology";
    this.name = "gcp";
    this._project = "";
    this._region = "us-central1";
    this._compute = null;
    this._run = null;
    this._container = null;
    this._snapshot = null;
    this._snapshotExpiresAt = 0;
    this._watchers = new Set();
    this._watchTimer = null;
    this._buildRevision = 0;
    this._sdkLoadError = null;
  }

  async connect(config) {
    this.name = config.name || "gcp";
    this._project =
      config.project ||
      config.auth?.project ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCLOUD_PROJECT ||
      "";
    this._region =
      config.region ||
      config.auth?.region ||
      process.env.GOOGLE_CLOUD_REGION ||
      "us-central1";

    // Test path: injected clients.
    if (config._compute && config._run && config._container) {
      this._compute = config._compute;
      this._run = config._run;
      this._container = config._container;
      return;
    }

    if (!this._project) {
      this._sdkLoadError = "GOOGLE_CLOUD_PROJECT not set (or pass project in source config)";
      return;
    }

    try {
      const sdk = await loadSdk();
      this._compute = new sdk.InstancesClient();
      this._run = new sdk.ServicesClient();
      this._container = new sdk.ClusterManagerClient();
    } catch (err) {
      this._sdkLoadError = err instanceof Error ? err.message : String(err);
    }
  }

  async healthCheck() {
    if (this._sdkLoadError) {
      return { status: "down", latencyMs: 0, message: `gcp sdk not installed: ${this._sdkLoadError}` };
    }
    const t0 = Date.now();
    try {
      // Cheapest probe: list compute instances in the configured zone
      // with a 1-record cap. The aggregated request would fan out
      // across every zone — overkill for a health check.
      const zone = `${this._region}-a`;
      await this._compute.list({ project: this._project, zone, maxResults: 1 });
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
      .filter((r) => r.kind === "cloud_service" || r.kind === "cloud_cluster")
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
        this._snapshotExpiresAt = Date.now() + SNAPSHOT_TTL_MS;
        for (const l of this._watchers) {
          try { l({ type: "resync", snapshot: snap }); } catch { /* skip */ }
        }
      }, SNAPSHOT_TTL_MS);
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

  async _refreshIfStale() {
    const now = Date.now();
    if (this._snapshot && now < this._snapshotExpiresAt) return this._snapshot;
    if (this._sdkLoadError) {
      return { source: this.name, resources: [], edges: [], revision: 0 };
    }
    const snap = await this._buildSnapshot();
    this._snapshot = snap;
    this._snapshotExpiresAt = now + SNAPSHOT_TTL_MS;
    return snap;
  }

  async _buildSnapshot() {
    const project = this._project;
    const resources = [];
    const edges = [];

    // --- Compute Engine instances (aggregated across zones) -----------
    const aggResp = await this._compute.aggregatedList({ project });
    // The aggregatedList iterator yields [zone, payload] pairs OR
    // (in unit tests) returns an array shape — accept both.
    const aggIter = Array.isArray(aggResp) ? aggResp[0] : aggResp;
    const aggObj = typeof aggIter?.[Symbol.asyncIterator] === "function" ? null : aggIter;
    if (aggObj && typeof aggObj === "object") {
      for (const [zoneKey, payload] of Object.entries(aggObj)) {
        const zone = zoneKey.replace(/^zones\//, "");
        for (const inst of payload?.instances || []) {
          resources.push({
            id: id.gce(project, zone, inst.name),
            kind: "cloud_node",
            name: inst.name,
            source: this.name,
            labels: {
              project,
              zone,
              machineType: (inst.machineType || "").split("/").pop(),
              status: inst.status || "unknown",
            },
            attributes: { provider: "gcp", service: "gce" },
          });
        }
      }
    }

    // --- Cloud Run services (per-region) ------------------------------
    const region = this._region;
    const runResp = await this._run.listServices({ parent: `projects/${project}/locations/${region}` });
    const runList = Array.isArray(runResp) ? runResp[0] : runResp;
    for (const svc of runList || []) {
      const shortName = (svc.name || "").split("/").pop();
      if (!shortName) continue;
      resources.push({
        id: id.cloudRun(project, region, shortName),
        kind: "cloud_service",
        name: shortName,
        source: this.name,
        labels: { project, region, runtime: "cloud-run" },
        attributes: { provider: "gcp", service: "cloud-run", canonicalName: shortName.toLowerCase() },
      });
    }

    // --- GKE clusters + nodepools -------------------------------------
    const gkeResp = await this._container.listClusters({ parent: `projects/${project}/locations/-` });
    const gkeList = Array.isArray(gkeResp) ? gkeResp[0] : gkeResp;
    const clusters = gkeList?.clusters || [];
    for (const cluster of clusters) {
      const clusterRes = {
        id: id.gkeCluster(project, cluster.location, cluster.name),
        kind: "cloud_cluster",
        name: cluster.name,
        source: this.name,
        labels: {
          project,
          location: cluster.location,
          version: cluster.currentMasterVersion || "",
          status: cluster.status || "",
        },
        attributes: { provider: "gcp", service: "gke" },
      };
      resources.push(clusterRes);
      for (const np of cluster.nodePools || []) {
        const npRes = {
          id: id.gkeNodepool(project, cluster.location, cluster.name, np.name),
          kind: "cloud_node",
          name: np.name,
          source: this.name,
          labels: {
            project,
            cluster: cluster.name,
            machineType: np.config?.machineType || "",
            initial_count: String(np.initialNodeCount ?? 0),
          },
          attributes: { provider: "gcp", service: "gke" },
        };
        resources.push(npRes);
        edges.push({ from: npRes.id, to: clusterRes.id, relation: "OWNED_BY", confidence: 1.0 });
      }
    }

    this._buildRevision += 1;
    return { source: this.name, resources, edges, revision: this._buildRevision };
  }
}

export default function create() {
  return new GcpConnector();
}
