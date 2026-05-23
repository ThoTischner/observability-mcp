// Live integration check for the Kubernetes topology connector.
//
// Assumes a working kubeconfig in $KUBECONFIG or ~/.kube/config that
// points at a reachable cluster, and that the manifests in
// .github/integration/kubernetes/workload.yaml have already been applied
// (the GH Actions job and the local "make k8s-it" recipe both do this).
//
// Drives the connector through real watch events, then asserts the
// expected graph appeared. Exits non-zero on the first failure.

import { setTimeout as sleep } from "node:timers/promises";
import { KubernetesConnector } from "../src/connectors/kubernetes.js";
import { createInformerFactory } from "../src/connectors/kubernetes-client.js";
import { setDefaultInformerFactoryProvider } from "../src/connectors/kubernetes.js";
import type { SourceConfig } from "../src/types.js";

const NS = process.env.K8S_IT_NAMESPACE ?? "omcp-it";
const APP = process.env.K8S_IT_APP ?? "omcp-it-echo";
const TIMEOUT_MS = Number(process.env.K8S_IT_TIMEOUT_MS ?? "60000");

setDefaultInformerFactoryProvider(createInformerFactory);

const cfg: SourceConfig = {
  name: "kind-cluster",
  type: "kubernetes",
  url: "",
  enabled: true,
};

function fail(msg: string): never {
  console.error("FAIL:", msg);
  process.exit(1);
}

async function main() {
  const conn = new KubernetesConnector();
  console.log("connecting to cluster...");
  await conn.connect(cfg);

  const health = await conn.healthCheck();
  console.log("healthCheck:", health);
  if (health.status !== "up") fail(`healthCheck not up: ${health.message}`);

  const deadline = Date.now() + TIMEOUT_MS;
  let snap = await conn.getTopologySnapshot();
  while (Date.now() < deadline) {
    snap = await conn.getTopologySnapshot();
    const podOk = snap.resources.some(
      (r) => r.kind === "pod" && r.labels.app === APP && r.id.startsWith(`k8s:pod:${NS}/`),
    );
    const depOk = snap.resources.some(
      (r) => r.id === `k8s:deployment:${NS}/${APP}`,
    );
    const nodeOk = snap.resources.some((r) => r.kind === "node");
    const nsOk = snap.resources.some((r) => r.id === `k8s:namespace:${NS}`);
    if (podOk && depOk && nodeOk && nsOk) break;
    await sleep(1000);
  }

  console.log("snapshot:", {
    revision: snap.revision,
    resources: snap.resources.length,
    edges: snap.edges.length,
  });

  const pod = snap.resources.find(
    (r) => r.kind === "pod" && r.labels.app === APP,
  );
  if (!pod) fail(`no pod with label app=${APP} found in namespace ${NS}`);
  const dep = snap.resources.find((r) => r.id === `k8s:deployment:${NS}/${APP}`);
  if (!dep) fail(`deployment ${NS}/${APP} not in graph`);
  if (!snap.resources.some((r) => r.id === `k8s:namespace:${NS}`)) {
    fail(`namespace ${NS} not in graph`);
  }
  if (!snap.resources.some((r) => r.kind === "node")) fail("no node resources discovered");

  // RUNS_ON: pod → node
  const runsOn = snap.edges.find((e) => e.from === pod.id && e.relation === "RUNS_ON");
  if (!runsOn) fail(`pod ${pod.id} has no RUNS_ON edge`);
  if (!runsOn.to.startsWith("k8s:node:")) fail(`RUNS_ON target is not a node: ${runsOn.to}`);

  // OWNED_BY chain: pod → replicaset → deployment
  const ownedBy = snap.edges.find((e) => e.from === pod.id && e.relation === "OWNED_BY");
  if (!ownedBy) fail(`pod ${pod.id} has no OWNED_BY edge`);
  if (!ownedBy.to.startsWith(`k8s:replicaset:${NS}/`)) {
    fail(`pod OWNED_BY target is not a replicaset: ${ownedBy.to}`);
  }
  const rsOwned = snap.edges.find(
    (e) => e.from === ownedBy.to && e.relation === "OWNED_BY" && e.to === dep.id,
  );
  if (!rsOwned) fail(`replicaset ${ownedBy.to} has no OWNED_BY → ${dep.id}`);

  // IN_NAMESPACE
  if (!snap.edges.some((e) => e.from === pod.id && e.relation === "IN_NAMESPACE")) {
    fail(`pod ${pod.id} has no IN_NAMESPACE edge`);
  }

  console.log("OK — full topology chain present:");
  console.log(`  ${pod.id}`);
  console.log(`    RUNS_ON   → ${runsOn.to}`);
  console.log(`    OWNED_BY  → ${ownedBy.to}`);
  console.log(`             OWNED_BY → ${dep.id}`);

  await conn.disconnect();
}

main().catch((err) => {
  console.error("integration check threw:", err);
  process.exit(1);
});
