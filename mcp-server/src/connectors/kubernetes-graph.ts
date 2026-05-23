// Pure graph-building helpers for the Kubernetes connector.
//
// All Kubernetes object → Resource/Edge translation lives here so it can
// be unit-tested without a live API server. The connector class
// (kubernetes.ts) wires these into the watch event handlers.

import type { Resource, Edge, TopologySnapshot, TopologyChangeEvent } from "../types.js";

// Minimal shape of a Kubernetes object — we only consume the bits we
// need, so we don't pull the full @kubernetes/client-node types into
// modules that don't depend on the SDK.
export interface KubeObjectMeta {
  name?: string;
  namespace?: string;
  uid?: string;
  labels?: Record<string, string>;
  ownerReferences?: Array<{ kind: string; name: string; uid?: string }>;
}

export interface KubePod {
  metadata?: KubeObjectMeta;
  spec?: { nodeName?: string };
  status?: { phase?: string };
}

export interface KubeNode {
  metadata?: KubeObjectMeta;
  status?: { conditions?: Array<{ type: string; status: string }> };
}

export interface KubeDeployment {
  metadata?: KubeObjectMeta;
}

export interface KubeReplicaSet {
  metadata?: KubeObjectMeta;
}

export interface KubeNamespace {
  metadata?: KubeObjectMeta;
}

// --- Canonical IDs ------------------------------------------------------

export function namespacedId(kind: string, namespace: string, name: string): string {
  return `k8s:${kind}:${namespace}/${name}`;
}

export function clusterScopedId(kind: string, name: string): string {
  return `k8s:${kind}:${name}`;
}

// --- Resource builders --------------------------------------------------

const baseLabels = (m?: KubeObjectMeta): Record<string, string> => ({ ...(m?.labels ?? {}) });
const baseAttrs = (m?: KubeObjectMeta): Record<string, unknown> =>
  m?.uid ? { uid: m.uid } : {};

export function podResource(source: string, pod: KubePod): Resource | undefined {
  const name = pod.metadata?.name;
  const namespace = pod.metadata?.namespace;
  if (!name || !namespace) return undefined;
  return {
    id: namespacedId("pod", namespace, name),
    kind: "pod",
    name,
    source,
    labels: baseLabels(pod.metadata),
    attributes: {
      ...baseAttrs(pod.metadata),
      ...(pod.status?.phase ? { phase: pod.status.phase } : {}),
      ...(pod.spec?.nodeName ? { nodeName: pod.spec.nodeName } : {}),
    },
  };
}

export function nodeResource(source: string, node: KubeNode): Resource | undefined {
  const name = node.metadata?.name;
  if (!name) return undefined;
  const ready = node.status?.conditions?.find((c) => c.type === "Ready")?.status;
  return {
    id: clusterScopedId("node", name),
    kind: "node",
    name,
    source,
    labels: baseLabels(node.metadata),
    attributes: { ...baseAttrs(node.metadata), ...(ready ? { ready } : {}) },
  };
}

export function deploymentResource(source: string, d: KubeDeployment): Resource | undefined {
  const name = d.metadata?.name;
  const namespace = d.metadata?.namespace;
  if (!name || !namespace) return undefined;
  return {
    id: namespacedId("deployment", namespace, name),
    kind: "deployment",
    name,
    source,
    labels: baseLabels(d.metadata),
    attributes: baseAttrs(d.metadata),
  };
}

export function replicaSetResource(source: string, rs: KubeReplicaSet): Resource | undefined {
  const name = rs.metadata?.name;
  const namespace = rs.metadata?.namespace;
  if (!name || !namespace) return undefined;
  return {
    id: namespacedId("replicaset", namespace, name),
    kind: "replicaset",
    name,
    source,
    labels: baseLabels(rs.metadata),
    attributes: baseAttrs(rs.metadata),
  };
}

export function namespaceResource(source: string, ns: KubeNamespace): Resource | undefined {
  const name = ns.metadata?.name;
  if (!name) return undefined;
  return {
    id: clusterScopedId("namespace", name),
    kind: "namespace",
    name,
    source,
    labels: baseLabels(ns.metadata),
    attributes: baseAttrs(ns.metadata),
  };
}

// --- Edge builders ------------------------------------------------------

const KNOWN_OWNER_KINDS: Record<string, string> = {
  Deployment: "deployment",
  ReplicaSet: "replicaset",
  StatefulSet: "statefulset",
  DaemonSet: "daemonset",
  Job: "job",
  CronJob: "cronjob",
};

function ownerEdges(
  source: string,
  fromId: string,
  meta: KubeObjectMeta | undefined,
  namespace: string,
): Edge[] {
  const out: Edge[] = [];
  for (const ref of meta?.ownerReferences ?? []) {
    const kind = KNOWN_OWNER_KINDS[ref.kind];
    if (!kind) continue;
    out.push({
      from: fromId,
      to: namespacedId(kind, namespace, ref.name),
      relation: "OWNED_BY",
      source,
      confidence: 1.0,
    });
  }
  return out;
}

export function podEdges(source: string, pod: KubePod): Edge[] {
  const name = pod.metadata?.name;
  const namespace = pod.metadata?.namespace;
  if (!name || !namespace) return [];
  const fromId = namespacedId("pod", namespace, name);
  const edges: Edge[] = [
    {
      from: fromId,
      to: clusterScopedId("namespace", namespace),
      relation: "IN_NAMESPACE",
      source,
      confidence: 1.0,
    },
  ];
  if (pod.spec?.nodeName) {
    edges.push({
      from: fromId,
      to: clusterScopedId("node", pod.spec.nodeName),
      relation: "RUNS_ON",
      source,
      confidence: 1.0,
    });
  }
  edges.push(...ownerEdges(source, fromId, pod.metadata, namespace));
  return edges;
}

export function replicaSetEdges(source: string, rs: KubeReplicaSet): Edge[] {
  const name = rs.metadata?.name;
  const namespace = rs.metadata?.namespace;
  if (!name || !namespace) return [];
  const fromId = namespacedId("replicaset", namespace, name);
  return [
    {
      from: fromId,
      to: clusterScopedId("namespace", namespace),
      relation: "IN_NAMESPACE",
      source,
      confidence: 1.0,
    },
    ...ownerEdges(source, fromId, rs.metadata, namespace),
  ];
}

export function deploymentEdges(source: string, d: KubeDeployment): Edge[] {
  const name = d.metadata?.name;
  const namespace = d.metadata?.namespace;
  if (!name || !namespace) return [];
  return [
    {
      from: namespacedId("deployment", namespace, name),
      to: clusterScopedId("namespace", namespace),
      relation: "IN_NAMESPACE",
      source,
      confidence: 1.0,
    },
  ];
}

// --- Graph store --------------------------------------------------------

/**
 * In-memory store of the connector's current view of the cluster. The
 * watch event handlers call add/remove and the store emits incremental
 * change events to subscribers.
 *
 * Edges are tracked per-owner-resource so when a pod is deleted we can
 * cleanly remove its outgoing edges without scanning the whole edge map.
 */
export class TopologyStore {
  private resources = new Map<string, Resource>();
  private edgesByOwner = new Map<string, Edge[]>(); // ownerId → outgoing edges
  private rev = 0;
  private listeners = new Set<(e: TopologyChangeEvent) => void>();

  constructor(private readonly source: string) {}

  get revision(): number {
    return this.rev;
  }

  subscribe(listener: (e: TopologyChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: TopologyChangeEvent): void {
    this.rev++;
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // listener errors must not poison the watch loop
      }
    }
  }

  upsertResource(r: Resource, ownedEdges: Edge[]): void {
    const existed = this.resources.has(r.id);
    this.resources.set(r.id, r);

    // Replace edges originating from this resource atomically.
    const prev = this.edgesByOwner.get(r.id) ?? [];
    this.edgesByOwner.set(r.id, ownedEdges);

    this.emit({ type: existed ? "resource_updated" : "resource_added", resource: r });
    // Diff edges so subscribers see precise add/remove.
    const prevKeys = new Set(prev.map(edgeKey));
    const nextKeys = new Set(ownedEdges.map(edgeKey));
    for (const e of prev) if (!nextKeys.has(edgeKey(e))) this.emit({ type: "edge_removed", edge: e });
    for (const e of ownedEdges) if (!prevKeys.has(edgeKey(e))) this.emit({ type: "edge_added", edge: e });
  }

  removeResource(id: string): void {
    const r = this.resources.get(id);
    if (!r) return;
    this.resources.delete(id);
    const prev = this.edgesByOwner.get(id) ?? [];
    this.edgesByOwner.delete(id);
    for (const e of prev) this.emit({ type: "edge_removed", edge: e });
    this.emit({ type: "resource_removed", resource: r });
  }

  listResources(): Resource[] {
    return Array.from(this.resources.values());
  }

  listEdges(): Edge[] {
    const out: Edge[] = [];
    for (const arr of this.edgesByOwner.values()) out.push(...arr);
    return out;
  }

  snapshot(): TopologySnapshot {
    return {
      source: this.source,
      resources: this.listResources(),
      edges: this.listEdges(),
      revision: this.rev,
    };
  }
}

function edgeKey(e: Edge): string {
  return `${e.from}|${e.relation}|${e.to}`;
}
