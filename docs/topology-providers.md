# Topology providers (since v2.x / Phase F14)

The gateway's topology graph (`get_topology`, `get_blast_radius`) is
built by **providers** — each provider is a connector that
implements the optional topology capability (`listResources`,
`listEdges`, `getTopologySnapshot`, `watchTopology`). The MCP tools
fan out across every provider in the caller's tenant and present a
single unified graph.

This page describes:

- which providers ship today and which are planned,
- how the gateway reconciles nodes that appear in multiple providers
  (the **canonical name** rule),
- the per-provider configuration shape.

## Providers

| Provider | Source name | Status | Notes |
|---|---|---|---|
| Kubernetes | `kubernetes` | ✅ shipped (in-tree) | Watches Deployments, Pods, Services, Namespaces, Nodes. Edges via ownerReferences + service selectors. |
| AWS | `aws` | ✅ shipped (Q1 / v3.1) | EC2 + ECS clusters/services/tasks + EKS clusters/nodegroups. Edges: ECS task → service (OWNED_BY); ECS service → cluster (OWNED_BY); EKS nodegroup → cluster (OWNED_BY). Snapshots memoized for 30 s. Auth via standard AWS SDK credential chain. |
| GCP | `gcp` | 🔧 follow-up | GKE workloads, Cloud Run, Cloud SQL, Pub/Sub. Edges via Service Directory + VPC peerings. |
| Consul | `consul` | 🔧 follow-up | Service registry + intentions over the Consul HTTP API. |
| Istio | `istio` | ✅ shipped (Q2 / v3.1) | CALLS graph derived from `istio_requests_total` in the operator's existing Prometheus. Workload names + namespaces from `source_workload`/`destination_workload` telemetry-v2 labels. Edge `confidence` ∈ [0.5, 1.0] reflects relative request volume so chatty edges rank above rare ones. Snapshots memoized 30 s. Auth via optional Bearer token. |
| Linkerd | `linkerd` | 🔧 follow-up | mTLS-protected call edges, identity-aware. |
| Tempo | `tempo` | ✅ shipped (plugin) | CALLS edges derived from a sampled batch of recent traces. |

Reserved kind/relation vocabulary for the multi-cloud providers is
documented in [`topology-vocabulary.md`](topology-vocabulary.md). The
merger logic lives in [`mcp-server/src/topology/merge.ts`](https://github.com/ThoTischner/observability-mcp/blob/main/mcp-server/src/topology/merge.ts) — covered by 11 unit tests in F14.

## How the merger collapses cross-provider duplicates

When two providers emit nodes for the same logical workload — the
k8s `payment` Deployment AND an ECS `payment-service` AND a Tempo
`trace_service` `payment` — the gateway collapses them into one
node so `get_blast_radius` walks the real graph, not three ghosts.

The merger applies rules in priority order:

1. **Explicit override.** A `Resource` carrying
   `attributes.canonicalName` provides the canonical name directly.
   Operators set this in `catalog.yaml` for the gold-standard mapping
   when label conventions are inconsistent.
2. **Label match.** A label whose key appears in
   `CANONICAL_LABEL_KEYS` (`app.kubernetes.io/name`,
   `app.kubernetes.io/instance`, `app`, `service`, `service.name`,
   `k8s-app`) provides the canonical name. Lookup is case-insensitive
   and the first key in that order wins, so two providers using
   different labels still converge.
3. **Kind compatibility.** Two nodes only merge when their kinds are
   in the `MERGEABLE_KIND_PAIRS` table. Examples:
   - `deployment` + `cloud_service` → merge
   - `deployment` + `trace_service` → merge
   - `cloud_service` + `trace_service` → merge
   - `pod` + `container` → merge
   - `pod` + `function` → **do NOT merge** (incompatible — keeps the
     graph verbose instead of producing a wrong join)

The collapsed node:
- keeps the **most-specific kind** (priority: `cloud_service` >
  `deployment` > `pod` > `trace_service` > others)
- inherits the **union of labels** (later providers win on collision)
- inherits the **union of attributes** + an extra
  `attributes.mergedFrom: string[]` listing every `source:id` that
  contributed
- picks the most stable id (lexicographic by `source`, then `id`)

Edges that pointed at any of the collapsed ids are rewritten to the
canonical id, **self-loops** created by the collapse are dropped,
and **identical `(from,to,relation)` tuples** that arose from the
collapse are deduped.

## Configuring a provider

Each provider is a regular connector — declare it in
`sources.yaml` like any other:

```yaml
sources:
  - name: prod-aws
    type: aws
    enabled: true
    config:
      regions: [eu-west-1, us-east-1]
      assumeRoleArn: arn:aws:iam::123456789012:role/observability-mcp-read
  - name: prod-gcp
    type: gcp
    enabled: true
    config:
      project: my-project
      credentialsJsonFile: /etc/secrets/gcp-key.json
```

Helm-side: stash the credentials in Secrets and reference them via
the `extraEnv` block so the values never live in the chart values.
Example for AWS using the standard SDK env names:

```yaml
extraEnv:
  - name: AWS_REGION
    value: eu-west-1
  - name: AWS_ROLE_ARN
    value: arn:aws:iam::123456789012:role/observability-mcp-read
  - name: AWS_WEB_IDENTITY_TOKEN_FILE
    value: /var/run/secrets/aws-iam-token
```

(The exact env shape will land with each provider — this page is the
canonical reference once they do.)

## Operational notes

- **Provider failures degrade gracefully** — a sick AWS connector
  returns an empty resource list from its `listResources()` call;
  `get_topology` keeps every other provider's contribution and notes
  the missing source in its response. The merger never fails on a
  missing input.
- **Catalog-driven overrides** — when the team you bought the
  service from disagrees with the label convention, write the
  authoritative pairing into `catalog.yaml`:
  ```yaml
  services:
    payment-service:
      canonicalName: payment
      providers: [k8s, aws-ecs, tempo]
  ```
  The `canonicalName` attribute then flows through the topology
  loader into `attributes.canonicalName` on every Resource the
  loader knows about.

## What ships in F14 vs follow-up

F14 ships the **foundation** — the merger module, the canonical-name
rule, the vocabulary extension, and this docs page. The five
concrete cloud-provider connectors (`aws`, `gcp`, `consul`, `istio`,
`linkerd`) ship as separate filesystem plugins in F14b/c/d/e/f. The
merger is connector-agnostic, so a plugin landing later requires
zero changes here — it just shows up in the unified graph.
