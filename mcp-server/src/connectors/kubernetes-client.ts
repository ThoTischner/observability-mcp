// Thin adapter around @kubernetes/client-node. Kept in its own file so
// the connector class itself stays SDK-free and unit-testable. The
// loader imports this lazily so installations that don't configure a
// kubernetes source don't pay the import cost.

import {
  KubeConfig,
  CoreV1Api,
  AppsV1Api,
  makeInformer,
  type Informer as K8sInformer,
  type KubernetesObject,
  type V1Pod,
  type V1Node,
  type V1Deployment,
  type V1ReplicaSet,
  type V1Namespace,
} from "@kubernetes/client-node";
import type { SourceConfig } from "../types.js";
import type { Informer, InformerFactory } from "./kubernetes.js";
import type {
  KubePod,
  KubeNode,
  KubeDeployment,
  KubeReplicaSet,
  KubeNamespace,
} from "./kubernetes-graph.js";

function buildKubeConfig(config: SourceConfig): KubeConfig {
  const kc = new KubeConfig();
  if (config.auth?.type === "bearer" && config.auth.token && config.url) {
    // Explicit cluster + bearer-token config (e.g. remote cluster).
    kc.loadFromOptions({
      clusters: [
        {
          name: config.name,
          server: config.url,
          skipTLSVerify: !!(config.tls?.skipVerify ?? config.tlsSkipVerify),
          caFile: config.tls?.caCert,
        },
      ],
      users: [{ name: config.name, token: config.auth.token }],
      contexts: [{ name: config.name, cluster: config.name, user: config.name }],
      currentContext: config.name,
    });
    return kc;
  }
  // Fall through: in-cluster (ServiceAccount) or KUBECONFIG/~/.kube/config.
  // In @kubernetes/client-node v1.x, loadFromCluster() no longer throws
  // when env+files are missing — it silently produces "https://undefined:undefined".
  // Detect in-cluster context by the well-known env vars instead.
  const inCluster =
    !!process.env.KUBERNETES_SERVICE_HOST && !!process.env.KUBERNETES_SERVICE_PORT;
  if (inCluster) {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();
  }
  return kc;
}

function wrapInformer<T extends KubernetesObject>(inf: K8sInformer<T>): Informer<T> {
  return {
    on(event, handler) {
      // @kubernetes/client-node Informer emits 'add' | 'update' | 'delete' | 'error'.
      inf.on(event as "add", handler as (o: T) => void);
    },
    async start() {
      await inf.start();
    },
    async stop() {
      await inf.stop();
    },
  };
}

export async function createInformerFactory(config: SourceConfig): Promise<InformerFactory> {
  const kc = buildKubeConfig(config);
  const core = kc.makeApiClient(CoreV1Api);
  const apps = kc.makeApiClient(AppsV1Api);

  // In @kubernetes/client-node v1+, list*() resolves directly to the
  // KubernetesListObject (with `items`), not the v0.x `{ body, response }`.
  const podInformer = makeInformer<V1Pod>(kc, "/api/v1/pods", () =>
    core.listPodForAllNamespaces(),
  );
  const nodeInformer = makeInformer<V1Node>(kc, "/api/v1/nodes", () => core.listNode());
  const nsInformer = makeInformer<V1Namespace>(kc, "/api/v1/namespaces", () =>
    core.listNamespace(),
  );
  const depInformer = makeInformer<V1Deployment>(kc, "/apis/apps/v1/deployments", () =>
    apps.listDeploymentForAllNamespaces(),
  );
  const rsInformer = makeInformer<V1ReplicaSet>(kc, "/apis/apps/v1/replicasets", () =>
    apps.listReplicaSetForAllNamespaces(),
  );

  return {
    pods: () => wrapInformer<V1Pod>(podInformer) as unknown as Informer<KubePod>,
    nodes: () => wrapInformer<V1Node>(nodeInformer) as unknown as Informer<KubeNode>,
    deployments: () =>
      wrapInformer<V1Deployment>(depInformer) as unknown as Informer<KubeDeployment>,
    replicaSets: () =>
      wrapInformer<V1ReplicaSet>(rsInformer) as unknown as Informer<KubeReplicaSet>,
    namespaces: () => wrapInformer<V1Namespace>(nsInformer) as unknown as Informer<KubeNamespace>,
    async healthCheck() {
      const start = Date.now();
      try {
        // /version is unauthenticated on most clusters and exists on all.
        await core.getAPIResources();
        return { ok: true, latencyMs: Date.now() - start };
      } catch (err) {
        return { ok: false, latencyMs: Date.now() - start, message: String(err) };
      }
    },
    async close() {
      await Promise.all([
        podInformer.stop().catch(() => {}),
        nodeInformer.stop().catch(() => {}),
        nsInformer.stop().catch(() => {}),
        depInformer.stop().catch(() => {}),
        rsInformer.stop().catch(() => {}),
      ]);
    },
  };
}
