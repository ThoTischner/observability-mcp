# Topology vocabulary

The connector-agnostic infrastructure graph in this project is built from two primitives:

```ts
interface Resource { id; kind; name; source; labels; attributes? }
interface Edge     { from; to; relation; source; confidence }
```

`kind` and `relation` are free-form strings at the type level — but the MCP tools (`get_topology`, `get_blast_radius`), the UI graph view, and any cross-connector reasoning all depend on connectors agreeing on what each value *means*. This document is that agreement.

The vocabulary is intentionally tiny: only values that are emitted by a shipped connector OR are reserved as the agreed name for a near-term connector. Extending it is a documentation change here plus an entry in `KINDS` / `RELATIONS` in `mcp-server/src/connectors/topology-vocabulary.ts`. The same module exports `validateResource`, `validateEdge`, and `validateSnapshot` which are wired into the kubernetes connector and emit a one-shot `console.warn` per distinct offender. Validation is warn-only by design — a connector that emits an unknown value still works, but the drift gets caught in CI before it spreads.

## Conventions

- `kind` is **lowercase singular**, ASCII (`pod`, not `Pods` or `pod_v1`).
- `relation` is **UPPER_SNAKE_CASE** verb phrase, read *from → to* (`pod RUNS_ON node`).
- `id` is the connector's canonical id for the resource and is opaque to consumers. It MUST be globally unique within the snapshot a single connector returns. Two connectors observing the same resource will currently report two ids; identity reconciliation across connectors is an open gap (see `docs/connectors.md`).
- `source` on both `Resource` and `Edge` is the connector's source name (e.g. `k8s-prod`) so the UI can colour-band by origin and `get_topology` can filter by source.
- `confidence` on an `Edge` is `[0, 1]`. Edges derived from authoritative APIs (k8s `ownerReferences`, `node.name`) use `1.0`. Inferred edges (e.g. service-to-service from trace spans) should use a lower number.

## Canonical `kind` values

| `kind` | Meaning | Used by | Notes |
|---|---|---|---|
| `pod` | Single running workload instance | kubernetes | One container or a tightly coupled group, in the K8s sense. |
| `node` | Host that runs pods | kubernetes | A Kubernetes worker node. Equivalent to `host` in non-k8s setups. |
| `deployment` | Versioned rollout managing replicas | kubernetes | The "ownership root" the agent reports as the affected workload. |
| `replicaset` | Mid-tier owner between `deployment` and `pod` | kubernetes | Surfaced so the ownership walk is faithful; rarely interesting on its own. |
| `namespace` | Logical scope grouping resources | kubernetes | Used by the UI scope filter; mapped onto AWS accounts / vCenter folders / NetBox sites for non-k8s connectors. |
| `service` | Long-lived addressable workload | reserved | For service-discovery-driven connectors (e.g. a future Consul or DNS-SD source). Distinct from a `deployment` because a service can be backed by anything. |
| `container` | Sub-pod runtime unit | reserved | Only needed once a connector cares about per-container telemetry independently. |
| `vm` | Virtual machine | reserved | vCenter/Proxmox/EC2 connectors. |
| `host` | Physical or virtual host outside k8s | reserved | Symmetric to `node` for non-k8s connectors. |
| `hypervisor` | Host that runs VMs | reserved | vCenter ESXi hosts, Proxmox nodes. |
| `cluster` | Logical container of nodes/hosts | reserved | For multi-cluster federation. |
| `cloud_service` | Managed cloud service (ECS service, Cloud Run, App Service) | reserved | Multi-cloud topology providers (F14) emit these. |
| `db_instance` | Managed database (RDS, Cloud SQL, Cosmos, …) | reserved | Multi-cloud. |
| `lb` | Load balancer (ELB/ALB/NLB, GCP LB, Azure LB) | reserved | Multi-cloud. |
| `queue` | Managed message queue (SQS, Pub/Sub, Service Bus) | reserved | Multi-cloud. |
| `function` | Serverless function (Lambda, Cloud Functions, Functions App) | reserved | Multi-cloud. |
| `serviceaccount` | Cloud or k8s identity a `cloud_service` runs as | reserved | Useful for blast-radius walks across IAM scope. |
| `mesh_proxy` | Service-mesh sidecar / gateway (Envoy, Linkerd-proxy) | reserved | Istio / Linkerd topology providers. |
| `trace_service` | Synthesised service node derived from trace spans | reserved | Phase F13 trace-edge integration; see `query_traces`. |

Reserved values do not have to be emitted today, but a future connector adding them does not need a fresh round of bikeshedding.

## Canonical-name reconciliation across providers

When two providers emit nodes for the same logical workload (k8s
`payment` Deployment AND ECS `payment-service` AND Tempo
`trace_service` `payment`), the topology merger uses these rules to
dedupe — see `mcp-server/src/topology/merge.ts`:

1. **Explicit override.** If a `Resource` carries
   `attributes.canonicalName`, that wins. Operators set this in
   `catalog.yaml` for the gold-standard mapping.
2. **Label match.** A label whose key is in `CANONICAL_LABEL_KEYS`
   (`app.kubernetes.io/name`, `app.kubernetes.io/instance`, `app`,
   `service`, `service.name`, `k8s-app`) provides the canonical
   name; the merger collapses any pair of nodes whose canonical
   labels match. First-key-wins in the listed order.
3. **Name + kind compatibility.** Last resort, with a per-kind
   compatibility table — `deployment` is mergeable with `cloud_service`
   and `trace_service`, but `pod` is NOT mergeable with `function`.

The merged node keeps the union of labels, the union of attributes
(later providers win on collision), and a `mergedFrom: string[]`
attribute listing every source that contributed.

## Canonical `relation` values

All relations are read **from → to**.

| `relation` | Semantics | Used by | Example |
|---|---|---|---|
| `RUNS_ON` | The `from` is physically hosted by the `to`. Co-tenancy via this relation is the basis of `get_blast_radius`. | kubernetes | `pod → node`, future `vm → hypervisor`, future `container → host`. |
| `OWNED_BY` | The `from` is managed by the `to`. Walking `OWNED_BY` to its terminus yields the *ownership root* — the deployable thing the operator cares about. | kubernetes | `pod → replicaset → deployment`. |
| `IN_NAMESPACE` | The `from` is scoped by the `to` for organisational purposes. Rendered as a background band in the UI graph rather than an edge to avoid collapse. | kubernetes | `pod → namespace`, future `vm → folder`, future `host → aws-account`. |
| `CALLS` | The `from` issues requests to the `to`. Edge weight (via `confidence`) reflects how strong the signal is. | reserved (tempo) | `service → service` derived from trace spans. |
| `CONTAINS` | The `from` is composed of the `to`. Use sparingly — `OWNED_BY` is usually the right tool. | reserved | `pod → container`, `vm → disk`. |
| `DEPENDS_ON` | Declared logical dependency, not inferred from traffic. | reserved | Catalog or manifest-derived. |

## Extending the vocabulary

1. Pick a name that fits the conventions above. Check the reserved list before inventing.
2. Add it to `KINDS` or `RELATIONS` in `mcp-server/src/connectors/topology-vocabulary.ts`.
3. Add a row in the appropriate table above with **what it means**, **who emits it**, and **an example**.
4. Add a test in `topology-vocabulary.test.ts` if the new value has interesting semantics worth pinning.

The validator runs in every topology-emitting connector and treats anything not in `KINDS` / `RELATIONS` as a warning — so a missed step here will surface as a one-shot `console.warn` per offending value the next time the snapshot is rendered.

## Versioning

The vocabulary follows the same release cadence as the server (`mcp-server/package.json` version). Adding a value is a *minor* bump. Renaming or removing a value is a *major* bump because connectors and downstream agents may have hard-coded it.
