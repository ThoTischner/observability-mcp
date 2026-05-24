# Kubernetes connector

A watch-based **topology** connector. Unlike Prometheus (metrics) or
Loki (logs), Kubernetes does not emit time-series — it describes
infrastructure shape: which pod runs on which node, which deployment
owns which pods, what namespace something lives in. The connector
exposes that shape as a generic `Resource` / `Edge` graph the rest of
the server can reason about without knowing any Kubernetes specifics.

> The model is intentionally generic — `kind` and `relation` are open
> strings, not TypeScript unions. A future vCenter / NetBox / NetApp
> connector emits `Resource`s and `Edge`s of its own kinds and
> relations; the same UI page, the same `get_topology` and
> `get_blast_radius` MCP tools, and the same correlator code consume
> them. See [`docs/connectors.md`](connectors.md) for the contract.

## What it discovers

The connector starts an [@kubernetes/client-node](https://github.com/kubernetes-client/javascript)
Informer per kind and keeps an in-memory store synchronised with the
cluster. No polling — the watch stream is the source of truth and the
store applies add/update/delete events as they arrive.

Resources emitted (`kind` value in the graph):

| Kind | Where it comes from | Cluster-scoped? |
|------|---------------------|-----------------|
| `node` | `/api/v1/nodes` | yes |
| `namespace` | `/api/v1/namespaces` | yes |
| `pod` | `/api/v1/pods` (all namespaces) | no |
| `deployment` | `/apis/apps/v1/deployments` | no |
| `replicaset` | `/apis/apps/v1/replicasets` | no |

Edges (`relation` value):

| Relation | Edge | Meaning |
|----------|------|---------|
| `RUNS_ON` | `pod → node` | Where the kubelet scheduled this pod. Universal "blast radius" pivot — `get_blast_radius` uses this relation across every topology connector. |
| `OWNED_BY` | `pod → replicaset`, `replicaset → deployment` | Built from each object's `metadata.ownerReferences`. Walked transitively by the tools/UI to find the ownership root (e.g. a Pod's terminal owner is its Deployment). |
| `IN_NAMESPACE` | `pod → namespace`, `deployment → namespace`, `replicaset → namespace` | Membership in a scope. Drawn as a tinted background band in the UI graph, not as an edge, to avoid star-shaped clutter. |

Canonical IDs follow `k8s:<kind>:<namespace>/<name>` for namespaced
kinds and `k8s:<kind>:<name>` for cluster-scoped ones. Pod names are
ephemeral by design (pods are cattle, not pets) — the K8s
`metadata.uid` is preserved in `attributes.uid` for future
cross-source entity resolution.

## Configuration

```yaml
sources:
  - name: my-cluster
    type: kubernetes
    enabled: true
    url: ""        # ignored — credentials come from kubeconfig
```

Authentication is picked up from:

1. `$KUBECONFIG`, if set and the file exists — the supported path for
   the in-compose demo (mcp-server reads
   `/k3s-kubeconfig/kubeconfig-internal.yaml` from a named volume).
2. `~/.kube/config`, otherwise.
3. In-cluster ServiceAccount when the well-known env vars
   `KUBERNETES_SERVICE_HOST` + `KUBERNETES_SERVICE_PORT` are present —
   the path the Helm chart uses by default.

The connector explicitly detects in-cluster via those env vars rather
than via `kc.loadFromCluster()`'s try/catch, because in
`@kubernetes/client-node` v1.x `loadFromCluster()` no longer throws
when files/env are missing — it silently returns
`https://undefined:undefined`. See `src/connectors/kubernetes-client.ts`.

## Permissions

In-cluster, the connector needs read-only access to the kinds it
watches. The minimum RBAC for a `kubernetes-source` ServiceAccount:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: omcp-topology-reader
rules:
  - apiGroups: [""]
    resources: ["nodes", "namespaces", "pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets"]
    verbs: ["get", "list", "watch"]
```

## What you can ask through MCP

Once the connector is connected and the watch has caught up, two MCP
tools are available to agents (in addition to the existing
metric/log tools):

- `get_topology` — return the merged resource/edge graph, optionally
  filtered by `source`, `kind`, or `scope` (e.g. namespace name or
  id). Hard cap of 5000 resources to keep agent context bounded.
- `get_blast_radius` — pivot on `RUNS_ON`: given any resource id, name
  or unique substring, return the host(s) it depends on and every
  other ownership-root running there. The canonical "if this host
  dies, who else fails?" question. If the target is itself a host
  (has incoming `RUNS_ON`), its tenants are reported.

The Web UI surfaces the same data under **Observability → Topology**
with three sub-tabs (Summary, Blast radius, layered graph).

## Live demo

`docker compose --profile demo up` brings up a single-node k3s and
applies a workload that puts the three chaos-able example services
(`api-gateway`, `payment-service`, `order-service`) into the
`omcp-demo` namespace. Prometheus and Loki scrape those same
Deployments — that is what lets an agent correlate a metric or log
anomaly with its underlying host. See
[`docs/configuration.md`](configuration.md) and
[`CLAUDE.md`](../CLAUDE.md) for the demo plumbing.

## Caveats

- **Single-node single-cluster only, today.** Multi-cluster federation
  is a future increment — adding a second `kubernetes` source today
  works mechanically but the connector does no cross-cluster entity
  resolution yet.
- **No metrics or logs.** This connector intentionally does not
  implement `queryMetrics` / `queryLogs`. Pair it with Prometheus +
  Loki for the full picture.
- **Pod IDs are ephemeral.** A pod recreate produces a new id. Stable
  identity sits at the Deployment level.
