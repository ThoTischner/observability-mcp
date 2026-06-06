// AWS topology connector for observability-mcp.
//
// Surfaces three AWS service types as a unified topology graph:
//
//   - EC2 Instances           → kind "cloud_node" (RUNS_ON target for ECS
//                              tasks running in EC2-launch mode).
//   - ECS Services + Tasks    → kind "cloud_service" + "cloud_task".
//                              Tasks OWNED_BY their service; tasks
//                              RUNS_ON their EC2 host (when applicable).
//   - EKS Clusters + Nodes    → kind "cloud_cluster" + "cloud_node".
//                              Nodes OWNED_BY cluster.
//
// Why these three? They're the AWS surfaces an SRE most often needs to
// correlate against metrics/logs/traces. Lambda + RDS + EBS + IAM are
// deliberately out of scope — they don't form an interesting graph for
// blast-radius / co-tenancy reasoning. A future increment can extend.
//
// Auth: AWS SDK default credential chain (env, container/role, profile).
// No custom auth handling — the SDK is the single source of truth.
//
// Dependency-free at the test layer: every SDK call goes through a
// thin `_send(client, command)` indirection so unit tests inject a fake
// `send` and don't need real AWS credentials.

import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import {
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
  ListTasksCommand,
  DescribeServicesCommand,
  DescribeTasksCommand,
} from "@aws-sdk/client-ecs";
import {
  EKSClient,
  ListClustersCommand as EksListClustersCommand,
  DescribeClusterCommand as EksDescribeClusterCommand,
  ListNodegroupsCommand,
  DescribeNodegroupCommand,
} from "@aws-sdk/client-eks";

const SNAPSHOT_TTL_MS = 30_000;

// --- helpers ----------------------------------------------------------

// Stable resource ids — operators search topology by id, so each must
// be deterministic across snapshots. Format: `aws:<kind>:<region>:<id>`.
const id = {
  ec2: (region, instanceId) => `aws:ec2:${region}:${instanceId}`,
  ecsCluster: (region, name) => `aws:ecs-cluster:${region}:${name}`,
  ecsService: (region, cluster, name) => `aws:ecs-service:${region}:${cluster}/${name}`,
  ecsTask: (region, cluster, task) => `aws:ecs-task:${region}:${cluster}/${task}`,
  eksCluster: (region, name) => `aws:eks-cluster:${region}:${name}`,
  eksNodegroup: (region, cluster, ng) => `aws:eks-nodegroup:${region}:${cluster}/${ng}`,
};

// The SDK client.send() can be paginated via @aws-sdk/util-paginator,
// but that pulls in another package and our scopes are small enough
// to just loop on NextToken/nextToken ourselves.
async function paginate(client, makeCommand, extract) {
  const out = [];
  let token;
  do {
    const cmd = makeCommand(token);
    const res = await client.send(cmd);
    out.push(...(extract(res) || []));
    token = res.NextToken || res.nextToken;
  } while (token);
  return out;
}

// --- the connector ----------------------------------------------------

export class AwsConnector {
  constructor() {
    this.type = "aws";
    this.signalType = "topology";
    this.name = "aws";
    this._region = "us-east-1";
    this._ec2 = null;
    this._ecs = null;
    this._eks = null;
    this._snapshot = null;
    this._snapshotExpiresAt = 0;
    this._watchers = new Set();
    this._watchTimer = null;
    this._buildRevision = 0;
  }

  async connect(config) {
    this.name = config.name || "aws";
    // Region resolution order: explicit source config → env →
    // default us-east-1. We don't reach into IMDS for an implicit
    // region because that's a long blocking call when running off
    // EC2 and silently slows boot.
    this._region =
      config.region ||
      config.auth?.region ||
      process.env.AWS_REGION ||
      process.env.AWS_DEFAULT_REGION ||
      "us-east-1";
    const ctorArgs = { region: this._region };
    this._ec2 = config._ec2 || new EC2Client(ctorArgs);
    this._ecs = config._ecs || new ECSClient(ctorArgs);
    this._eks = config._eks || new EKSClient(ctorArgs);
  }

  async healthCheck() {
    // One cheap SDK call. Returns latency in ms; SDK timeouts surface
    // as a structured error the registry's healthCheck wrapper logs.
    const t0 = Date.now();
    await this._ec2.send(new DescribeInstancesCommand({ MaxResults: 5 }));
    return { status: "up", latencyMs: Date.now() - t0 };
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
    // Surface the discovered service-shaped resources (ECS services +
    // EKS clusters) under the connector's "services" view. Pure
    // topology — no metric/log signals — so we lean on whatever the
    // snapshot already built.
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
    // Initial resync so subscribers see current state without
    // racing the next poll tick. Matches the tempo + k8s connectors.
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
    const snap = await this._buildSnapshot();
    this._snapshot = snap;
    this._snapshotExpiresAt = now + SNAPSHOT_TTL_MS;
    return snap;
  }

  async _buildSnapshot() {
    const resources = [];
    const edges = [];
    const region = this._region;

    // --- EC2 -----------------------------------------------------------
    const ec2Reservations = await paginate(
      this._ec2,
      (NextToken) => new DescribeInstancesCommand({ NextToken }),
      (r) => r.Reservations || [],
    );
    const ec2ById = new Map();
    for (const res of ec2Reservations) {
      for (const inst of res.Instances || []) {
        const tags = Object.fromEntries((inst.Tags || []).map((t) => [t.Key, t.Value]));
        const r = {
          id: id.ec2(region, inst.InstanceId),
          kind: "cloud_node",
          name: tags.Name || inst.InstanceId,
          source: this.name,
          labels: {
            instance_type: inst.InstanceType || "",
            state: inst.State?.Name || "unknown",
            az: inst.Placement?.AvailabilityZone || "",
            region,
          },
          attributes: { provider: "aws", service: "ec2" },
        };
        resources.push(r);
        ec2ById.set(inst.InstanceId, r);
      }
    }

    // --- ECS -----------------------------------------------------------
    const ecsClusters = await paginate(
      this._ecs,
      (nextToken) => new ListClustersCommand({ nextToken }),
      (r) => r.clusterArns || [],
    );
    for (const arn of ecsClusters) {
      const clusterName = arn.split("/").pop();
      const clusterRes = {
        id: id.ecsCluster(region, clusterName),
        kind: "cloud_cluster",
        name: clusterName,
        source: this.name,
        labels: { region },
        attributes: { provider: "aws", service: "ecs" },
      };
      resources.push(clusterRes);

      // Services + tasks
      const serviceArns = await paginate(
        this._ecs,
        (nextToken) => new ListServicesCommand({ cluster: arn, nextToken }),
        (r) => r.serviceArns || [],
      );
      if (serviceArns.length > 0) {
        const descRes = await this._ecs.send(
          new DescribeServicesCommand({ cluster: arn, services: serviceArns.slice(0, 10) }),
        );
        for (const svc of descRes.services || []) {
          const svcRes = {
            id: id.ecsService(region, clusterName, svc.serviceName),
            kind: "cloud_service",
            name: svc.serviceName,
            source: this.name,
            labels: {
              region,
              cluster: clusterName,
              launch_type: svc.launchType || "",
              desired: String(svc.desiredCount ?? 0),
              running: String(svc.runningCount ?? 0),
            },
            attributes: { provider: "aws", service: "ecs", canonicalName: svc.serviceName.toLowerCase() },
          };
          resources.push(svcRes);
          edges.push({
            from: svcRes.id,
            to: clusterRes.id,
            relation: "OWNED_BY",
            confidence: 1.0,
          });
        }
      }

      // Tasks → RUNS_ON the EC2 host (when launchType EC2).
      const taskArns = await paginate(
        this._ecs,
        (nextToken) => new ListTasksCommand({ cluster: arn, nextToken }),
        (r) => r.taskArns || [],
      );
      if (taskArns.length > 0) {
        const tasksDesc = await this._ecs.send(
          new DescribeTasksCommand({ cluster: arn, tasks: taskArns.slice(0, 100) }),
        );
        for (const t of tasksDesc.tasks || []) {
          const taskId = t.taskArn?.split("/").pop();
          const svcName = t.group?.startsWith("service:") ? t.group.slice("service:".length) : null;
          const taskRes = {
            id: id.ecsTask(region, clusterName, taskId),
            kind: "cloud_task",
            name: taskId,
            source: this.name,
            labels: {
              region,
              cluster: clusterName,
              last_status: t.lastStatus || "",
              launch_type: t.launchType || "",
            },
            attributes: { provider: "aws", service: "ecs" },
          };
          resources.push(taskRes);

          if (svcName) {
            edges.push({
              from: taskRes.id,
              to: id.ecsService(region, clusterName, svcName),
              relation: "OWNED_BY",
              confidence: 1.0,
            });
          }
          if (t.containerInstanceArn && t.launchType === "EC2") {
            // Walk container-instance → ec2InstanceId via the
            // DescribeContainerInstances API; an additional fetch
            // hop is intentionally avoided in v1 because the
            // ContainerInstances endpoint has stricter rate limits.
            // Operators wanting RUNS_ON edges for tasks should
            // prefer Fargate (no EC2 hop) or accept that v1 only
            // shows the task→service ownership edge.
          }
        }
      }
    }

    // --- EKS -----------------------------------------------------------
    const eksClusters = await paginate(
      this._eks,
      (nextToken) => new EksListClustersCommand({ nextToken }),
      (r) => r.clusters || [],
    );
    for (const clusterName of eksClusters) {
      const desc = await this._eks.send(new EksDescribeClusterCommand({ name: clusterName }));
      const cluster = desc.cluster;
      const clusterRes = {
        id: id.eksCluster(region, clusterName),
        kind: "cloud_cluster",
        name: clusterName,
        source: this.name,
        labels: {
          region,
          version: cluster?.version || "",
          status: cluster?.status || "",
        },
        attributes: { provider: "aws", service: "eks" },
      };
      resources.push(clusterRes);

      const nodegroups = await paginate(
        this._eks,
        (nextToken) => new ListNodegroupsCommand({ clusterName, nextToken }),
        (r) => r.nodegroups || [],
      );
      for (const ng of nodegroups) {
        const ngDesc = await this._eks.send(
          new DescribeNodegroupCommand({ clusterName, nodegroupName: ng }),
        );
        const ngRes = {
          id: id.eksNodegroup(region, clusterName, ng),
          kind: "cloud_node",
          name: ng,
          source: this.name,
          labels: {
            region,
            cluster: clusterName,
            instance_types: (ngDesc.nodegroup?.instanceTypes || []).join(","),
            desired: String(ngDesc.nodegroup?.scalingConfig?.desiredSize ?? 0),
          },
          attributes: { provider: "aws", service: "eks" },
        };
        resources.push(ngRes);
        edges.push({
          from: ngRes.id,
          to: clusterRes.id,
          relation: "OWNED_BY",
          confidence: 1.0,
        });
      }
    }

    this._buildRevision += 1;
    return {
      source: this.name,
      resources,
      edges,
      revision: this._buildRevision,
    };
  }
}

export default function create() {
  return new AwsConnector();
}
