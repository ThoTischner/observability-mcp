import { test } from "node:test";
import assert from "node:assert/strict";

import create, { AwsConnector } from "./index.js";

// --- helpers ----------------------------------------------------------
//
// We exercise the connector against fake EC2/ECS/EKS clients that
// match the AWS SDK's `client.send(command)` shape. No real AWS calls,
// no credentials.

function fakeSend(routes) {
  // routes: list of [matchFn, replyValue].
  return async (command) => {
    const name = command?.constructor?.name || "Unknown";
    for (const [match, reply] of routes) {
      if (match(name, command?.input || {})) {
        return typeof reply === "function" ? reply(command?.input || {}) : reply;
      }
    }
    throw new Error(`no fake reply for ${name}`);
  };
}

const ec2Empty = [
  [(n) => n === "DescribeInstancesCommand", { Reservations: [] }],
];
const ecsEmpty = [
  [(n) => n === "ListClustersCommand", { clusterArns: [] }],
];
const eksEmpty = [
  [(n) => n === "ListClustersCommand", { clusters: [] }],
];

function makeConnector(ec2Routes = ec2Empty, ecsRoutes = ecsEmpty, eksRoutes = eksEmpty) {
  const c = create();
  return c.connect({
    name: "aws-test",
    region: "eu-west-1",
    _ec2: { send: fakeSend(ec2Routes) },
    _ecs: { send: fakeSend(ecsRoutes) },
    _eks: { send: fakeSend(eksRoutes) },
  }).then(() => c);
}

// --- tests ------------------------------------------------------------

test("create() returns an AwsConnector with signalType topology", () => {
  const c = create();
  assert.ok(c instanceof AwsConnector);
  assert.equal(c.signalType, "topology");
  assert.equal(c.name, "aws");
});

test("connect() pulls region from config > env > default", async () => {
  const a = await makeConnector();
  assert.equal(a._region, "eu-west-1");

  delete process.env.AWS_REGION;
  delete process.env.AWS_DEFAULT_REGION;
  const c2 = create();
  await c2.connect({ name: "x", _ec2: { send: async () => ({}) }, _ecs: { send: async () => ({}) }, _eks: { send: async () => ({}) } });
  assert.equal(c2._region, "us-east-1");

  process.env.AWS_REGION = "eu-central-1";
  const c3 = create();
  await c3.connect({ name: "x", _ec2: { send: async () => ({}) }, _ecs: { send: async () => ({}) }, _eks: { send: async () => ({}) } });
  assert.equal(c3._region, "eu-central-1");
  delete process.env.AWS_REGION;
});

test("healthCheck issues one EC2 call and returns latency", async () => {
  const a = await makeConnector();
  const h = await a.healthCheck();
  assert.equal(h.status, "up");
  assert.ok(typeof h.latencyMs === "number" && h.latencyMs >= 0);
});

test("empty inventory → empty snapshot with revision incremented", async () => {
  const a = await makeConnector();
  const snap = await a.getTopologySnapshot();
  assert.equal(snap.source, "aws-test");
  assert.deepEqual(snap.resources, []);
  assert.deepEqual(snap.edges, []);
  assert.equal(snap.revision, 1);
});

test("EC2 instances → cloud_node resources with stable ids + tags", async () => {
  const a = await makeConnector(
    [[(n) => n === "DescribeInstancesCommand", {
      Reservations: [{
        Instances: [
          { InstanceId: "i-aaa", InstanceType: "t3.large", State: { Name: "running" },
            Placement: { AvailabilityZone: "eu-west-1a" }, Tags: [{ Key: "Name", Value: "web-1" }] },
          { InstanceId: "i-bbb", InstanceType: "t3.small", State: { Name: "stopped" },
            Placement: { AvailabilityZone: "eu-west-1b" }, Tags: [] },
        ],
      }],
    }]],
  );
  const snap = await a.getTopologySnapshot();
  assert.equal(snap.resources.length, 2);
  const web = snap.resources.find((r) => r.id === "aws:ec2:eu-west-1:i-aaa");
  assert.ok(web);
  assert.equal(web.name, "web-1");
  assert.equal(web.kind, "cloud_node");
  assert.equal(web.labels.instance_type, "t3.large");
  assert.equal(web.labels.az, "eu-west-1a");
  const bbb = snap.resources.find((r) => r.id === "aws:ec2:eu-west-1:i-bbb");
  assert.equal(bbb.name, "i-bbb"); // fallback to InstanceId when no Name tag
});

test("ECS clusters + services produce cloud_cluster/cloud_service + OWNED_BY edges", async () => {
  const a = await makeConnector(
    ec2Empty,
    [
      [(n) => n === "ListClustersCommand", { clusterArns: ["arn:aws:ecs:eu-west-1:111:cluster/prod-east"] }],
      [(n) => n === "ListServicesCommand", { serviceArns: ["arn:aws:ecs:eu-west-1:111:service/prod-east/checkout"] }],
      [(n) => n === "DescribeServicesCommand", {
        services: [{ serviceName: "checkout", launchType: "FARGATE", desiredCount: 3, runningCount: 3 }],
      }],
      [(n) => n === "ListTasksCommand", { taskArns: [] }],
    ],
  );
  const snap = await a.getTopologySnapshot();
  const clusterRes = snap.resources.find((r) => r.kind === "cloud_cluster");
  const svcRes = snap.resources.find((r) => r.kind === "cloud_service");
  assert.ok(clusterRes);
  assert.equal(clusterRes.name, "prod-east");
  assert.ok(svcRes);
  assert.equal(svcRes.name, "checkout");
  assert.equal(svcRes.attributes.canonicalName, "checkout");
  assert.equal(svcRes.labels.desired, "3");
  // OWNED_BY edge from service to cluster
  assert.ok(snap.edges.some((e) => e.from === svcRes.id && e.to === clusterRes.id && e.relation === "OWNED_BY"));
});

test("ECS tasks emit OWNED_BY their service", async () => {
  const a = await makeConnector(
    ec2Empty,
    [
      [(n) => n === "ListClustersCommand", { clusterArns: ["arn:aws:ecs:eu-west-1:111:cluster/prod"] }],
      [(n) => n === "ListServicesCommand", { serviceArns: ["arn:aws:ecs:eu-west-1:111:service/prod/checkout"] }],
      [(n) => n === "DescribeServicesCommand", { services: [{ serviceName: "checkout", launchType: "FARGATE" }] }],
      [(n) => n === "ListTasksCommand", { taskArns: ["arn:aws:ecs:eu-west-1:111:task/prod/abc123"] }],
      [(n) => n === "DescribeTasksCommand", {
        tasks: [{ taskArn: "arn:aws:ecs:eu-west-1:111:task/prod/abc123",
                  group: "service:checkout", launchType: "FARGATE", lastStatus: "RUNNING" }],
      }],
    ],
  );
  const snap = await a.getTopologySnapshot();
  const task = snap.resources.find((r) => r.kind === "cloud_task");
  assert.ok(task);
  assert.equal(task.name, "abc123");
  // task → service OWNED_BY
  assert.ok(snap.edges.some((e) => e.from === task.id && e.relation === "OWNED_BY" && e.to.endsWith("checkout")));
});

test("EKS clusters + nodegroups produce cluster + cloud_node + OWNED_BY", async () => {
  const a = await makeConnector(
    ec2Empty,
    ecsEmpty,
    [
      [(n) => n === "ListClustersCommand", { clusters: ["prod-eks"] }],
      [(n) => n === "DescribeClusterCommand", { cluster: { name: "prod-eks", version: "1.29", status: "ACTIVE" } }],
      [(n) => n === "ListNodegroupsCommand", { nodegroups: ["ng-default"] }],
      [(n) => n === "DescribeNodegroupCommand", {
        nodegroup: { nodegroupName: "ng-default", instanceTypes: ["m6i.large"], scalingConfig: { desiredSize: 4 } },
      }],
    ],
  );
  const snap = await a.getTopologySnapshot();
  const cluster = snap.resources.find((r) => r.kind === "cloud_cluster");
  const node = snap.resources.find((r) => r.kind === "cloud_node");
  assert.equal(cluster.name, "prod-eks");
  assert.equal(cluster.labels.version, "1.29");
  assert.equal(node.name, "ng-default");
  assert.equal(node.labels.instance_types, "m6i.large");
  assert.equal(node.labels.desired, "4");
  assert.ok(snap.edges.some((e) => e.from === node.id && e.to === cluster.id && e.relation === "OWNED_BY"));
});

test("listServices returns the discovered cloud_service + cloud_cluster names", async () => {
  const a = await makeConnector(
    ec2Empty,
    [
      [(n) => n === "ListClustersCommand", { clusterArns: ["arn:aws:ecs:eu-west-1:111:cluster/prod"] }],
      [(n) => n === "ListServicesCommand", { serviceArns: ["arn:aws:ecs:eu-west-1:111:service/prod/checkout"] }],
      [(n) => n === "DescribeServicesCommand", { services: [{ serviceName: "checkout", launchType: "FARGATE" }] }],
      [(n) => n === "ListTasksCommand", { taskArns: [] }],
    ],
  );
  const services = await a.listServices();
  // 1 cluster + 1 service
  assert.equal(services.length, 2);
  assert.ok(services.some((s) => s.name === "checkout"));
  assert.ok(services.some((s) => s.name === "prod"));
});

test("listResources + listEdges return the same arrays as getTopologySnapshot", async () => {
  const a = await makeConnector();
  const snap = await a.getTopologySnapshot();
  const r = await a.listResources();
  const e = await a.listEdges();
  assert.deepEqual(r, snap.resources);
  assert.deepEqual(e, snap.edges);
});

test("watchTopology delivers an initial resync + cleanup unsubscribes", async () => {
  const a = await makeConnector();
  const got = [];
  const unsub = a.watchTopology((ev) => got.push(ev));
  // queueMicrotask + tick
  await new Promise((r) => setImmediate(r));
  assert.ok(got.some((e) => e.type === "resync"));
  unsub();
  assert.equal(a._watchers.size, 0);
  await a.disconnect();
});

test("snapshot is cached for SNAPSHOT_TTL_MS", async () => {
  let descCalls = 0;
  const a = await makeConnector(
    [[(n) => { if (n === "DescribeInstancesCommand") { descCalls += 1; } return n === "DescribeInstancesCommand"; }, { Reservations: [] }]],
  );
  await a.getTopologySnapshot();
  await a.getTopologySnapshot();
  await a.getTopologySnapshot();
  // 1 healthCheck would not be called here; ensure only one buildSnapshot fired:
  assert.equal(descCalls, 1);
});
