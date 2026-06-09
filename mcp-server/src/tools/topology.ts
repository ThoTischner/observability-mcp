// MCP tools that expose the infrastructure topology graph to agents.
//
// Two tools live here:
//   - `get_topology`     — returns the merged resource/edge graph across
//                          every topology-capable connector, optionally
//                          filtered by source/kind/scope. Useful as a
//                          starting point for any cross-cutting question.
//   - `get_blast_radius` — given a resource, returns who else is co-tenant
//                          on the same host(s). The canonical "if this
//                          host fails, who else fails?" question.
//
// Both stay generic — they pivot on the `RUNS_ON` and `OWNED_BY` relations
// rather than any specific kind. Adding a vCenter/NetBox/AWS topology
// connector later requires zero changes here.

import type { ConnectorRegistry } from "../connectors/registry.js";
import { isTopologyProvider } from "../connectors/interface.js";
import type { Resource, Edge, TopologySnapshot } from "../types.js";
import { defaultContext, type RequestContext } from "../context.js";
import { mergeTopologies } from "../topology/merge.js";

// --- Shared helpers ----------------------------------------------------

interface AggregatedTopology {
  sources: Array<{ source: string; type: string; revision: number; resources: number; edges: number }>;
  resources: Resource[];
  edges: Edge[];
}

export async function aggregateTopology(registry: ConnectorRegistry, tenant?: string): Promise<AggregatedTopology> {
  const sources: AggregatedTopology["sources"] = [];
  const snapshots: TopologySnapshot[] = [];
  // Tenant-scoped when a tenant is supplied (call sites at the MCP
  // tool layer pass ctx.tenant); undefined preserves the original
  // global behaviour for internal / non-request callers.
  const connectors = tenant ? registry.getByTenant(tenant) : registry.getAll();
  for (const c of connectors) {
    if (!isTopologyProvider(c)) continue;
    try {
      const snap = await c.getTopologySnapshot();
      sources.push({
        source: snap.source,
        type: c.type,
        revision: snap.revision,
        resources: snap.resources.length,
        edges: snap.edges.length,
      });
      snapshots.push(snap);
    } catch {
      // A misbehaving connector must not poison the agent's view of the graph.
    }
  }
  // P1: run the snapshots through mergeTopologies so workloads
  // surfaced by more than one provider (e.g. the same Deployment
  // observed by both Kubernetes + a service-mesh connector) collapse
  // into a single canonical node and edges are rewritten to match.
  //
  // ONLY engages for multi-source topologies — with a single snapshot
  // the merger would mis-group intra-source siblings that happen to
  // share a canonical label (e.g. two pod replicas with
  // `app.kubernetes.io/name=api`). The merger is designed for
  // cross-provider de-duplication, not intra-provider.
  if (snapshots.length <= 1) {
    const only = snapshots[0];
    return {
      sources,
      resources: only?.resources ?? [],
      edges: only?.edges ?? [],
    };
  }
  const merged = mergeTopologies(snapshots);
  return { sources, resources: merged.resources, edges: merged.edges };
}

/**
 * Resolve a caller-supplied identifier to a Resource. Accepts:
 *   - exact canonical id (e.g. "k8s:pod:default/checkout-7f89d")
 *   - exact resource name (e.g. "checkout-7f89d")
 *   - case-insensitive substring of name (only used if uniquely matching)
 *
 * Stays generic — no knowledge of kind-specific id grammars.
 */
export function resolveResource(query: string, resources: Resource[]): Resource | { error: string; candidates?: string[] } {
  if (!query) return { error: "Missing resource query" };
  const exactId = resources.find((r) => r.id === query);
  if (exactId) return exactId;
  const exactName = resources.filter((r) => r.name === query);
  if (exactName.length === 1) return exactName[0];
  if (exactName.length > 1) {
    return {
      error: `Name '${query}' is ambiguous across ${exactName.length} resources; pass the full id`,
      candidates: exactName.map((r) => r.id),
    };
  }
  const q = query.toLowerCase();
  const fuzzy = resources.filter((r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    return {
      error: `Query '${query}' matched ${fuzzy.length} resources; pass the full id`,
      candidates: fuzzy.slice(0, 25).map((r) => r.id),
    };
  }
  return { error: `No resource found matching '${query}'` };
}

// --- get_topology ------------------------------------------------------

export const getTopologyDefinition = {
  name: "get_topology" as const,
  description:
    "Return the infrastructure topology graph as Resources and Edges. Use this when an agent needs to reason about which workload runs where, who owns whom, or which scope (namespace/project/folder) a resource belongs to.",
};

export interface GetTopologyArgs {
  source?: string;
  kind?: string;
  scope?: string;
  limit?: number;
}

export async function getTopologyHandler(
  registry: ConnectorRegistry,
  args: GetTopologyArgs = {},
  ctx: RequestContext = defaultContext(),
) {
  const agg = await aggregateTopology(registry, ctx.tenant);

  // Filtering — all optional. Filters compose conjunctively.
  let resources = agg.resources;
  let edges = agg.edges;

  if (args.source) {
    resources = resources.filter((r) => r.source === args.source);
    edges = edges.filter((e) => e.source === args.source);
  }
  if (args.kind) {
    resources = resources.filter((r) => r.kind === args.kind);
  }
  if (args.scope) {
    // Match either by scope resource id (e.g. "k8s:namespace:default") or by name (e.g. "default").
    const inScope = new Set<string>();
    for (const e of agg.edges) {
      if (e.relation !== "IN_NAMESPACE") continue;
      const target = agg.resources.find((r) => r.id === e.to);
      if (!target) continue;
      if (target.id === args.scope || target.name === args.scope) inScope.add(e.from);
    }
    resources = resources.filter((r) => inScope.has(r.id));
  }
  // Edges must still reference resources that survived filtering.
  const keepIds = new Set(resources.map((r) => r.id));
  edges = edges.filter((e) => keepIds.has(e.from) && keepIds.has(e.to));

  // Soft truncation so an agent can't accidentally pull a 10k-node graph
  // into context — defaults are generous but capped.
  const limit = Math.min(Math.max(args.limit ?? 500, 1), 5000);
  const truncated = resources.length > limit;
  if (truncated) {
    resources = resources.slice(0, limit);
    const keep2 = new Set(resources.map((r) => r.id));
    edges = edges.filter((e) => keep2.has(e.from) && keep2.has(e.to));
  }

  const payload: {
    sources: AggregatedTopology["sources"];
    resources: typeof resources;
    edges: typeof edges;
    total: { resources: number; edges: number };
    truncated: boolean;
    note?: string;
  } = {
    sources: agg.sources,
    resources,
    edges,
    total: { resources: agg.resources.length, edges: agg.edges.length },
    truncated,
  };
  // Signal vs. silence: when NO topology-capable connector contributed a
  // snapshot, an empty {resources:[],edges:[]} is ambiguous to an agent —
  // it can't tell "graph is genuinely empty" from "no topology backend is
  // wired up". Mirror query_traces' explicit "no backend" message so the
  // agent gets a clear signal instead of silence (issue #415).
  if (agg.sources.length === 0) {
    payload.note =
      "No topology-capable connector is configured, so the graph is empty. " +
      "Topology comes from connectors like the built-in `kubernetes` source " +
      "or the aws/gcp/istio/linkerd/consul providers — add one (see the " +
      "Sources tab or docs/plugin-architecture) to populate this graph. " +
      "A deployment with only metrics/logs backends (e.g. Prometheus/Loki) " +
      "has no topology to report here.";
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

// --- get_blast_radius --------------------------------------------------

export const getBlastRadiusDefinition = {
  name: "get_blast_radius" as const,
  description:
    "Given a resource, return the impact set if its underlying host(s) fail. Pivots on the generic RUNS_ON relation, so it works for pod→node, vm→hypervisor, container→host alike. Use this for cross-cutting RCA when several services degrade together.",
};

export interface GetBlastRadiusArgs {
  resource: string;
}

interface CoTenant {
  ownershipRoot: string;       // resource id of terminal OWNED_BY target (or the resource itself)
  ownershipRootName: string;
  ownershipRootKind: string;
  members: Array<{ id: string; name: string; kind: string }>;
}

interface BlastRadiusForHost {
  host: { id: string; name: string; kind: string };
  ownershipRoots: number;      // how many distinct services share this host
  coTenants: CoTenant[];
}

export async function getBlastRadiusHandler(
  registry: ConnectorRegistry,
  args: GetBlastRadiusArgs,
  ctx: RequestContext = defaultContext(),
) {
  const agg = await aggregateTopology(registry, ctx.tenant);
  const found = resolveResource(args.resource, agg.resources);
  if ("error" in found) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify(found, null, 2) }],
    };
  }

  // Index edges once.
  const byId = new Map(agg.resources.map((r) => [r.id, r]));
  const runsOnOut = new Map<string, string>();          // child → host
  const runsOnIn = new Map<string, Set<string>>();      // host → children
  const ownedByOut = new Map<string, string>();         // child → owner
  for (const e of agg.edges) {
    if (e.relation === "RUNS_ON") {
      runsOnOut.set(e.from, e.to);
      const s = runsOnIn.get(e.to) || new Set<string>();
      s.add(e.from);
      runsOnIn.set(e.to, s);
    } else if (e.relation === "OWNED_BY") {
      if (!ownedByOut.has(e.from)) ownedByOut.set(e.from, e.to);
    }
  }

  function ownershipRoot(id: string): string {
    let cur = id;
    for (let i = 0; i < 16; i++) {
      const next = ownedByOut.get(cur);
      if (!next || next === cur) return cur;
      cur = next;
    }
    return cur;
  }

  // Determine which hosts the target depends on. If the resource is itself
  // a host (incoming RUNS_ON exists), the host is the resource itself.
  const hosts: string[] = [];
  if (runsOnIn.has(found.id)) {
    hosts.push(found.id);
  } else if (runsOnOut.has(found.id)) {
    hosts.push(runsOnOut.get(found.id)!);
  }

  if (hosts.length === 0) {
    const payload = {
      target: { id: found.id, name: found.name, kind: found.kind },
      hosts: [],
      note: "This resource has no RUNS_ON edges in the current topology — either it is itself a top-level host with no tenants yet, or its connector does not emit RUNS_ON.",
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
  }

  const perHost: BlastRadiusForHost[] = [];
  for (const hostId of hosts) {
    const host = byId.get(hostId);
    if (!host) continue;
    const childIds = Array.from(runsOnIn.get(hostId) || []);
    // Bucket children by their ownership root.
    const buckets = new Map<string, CoTenant>();
    for (const cid of childIds) {
      const child = byId.get(cid);
      if (!child) continue;
      const rootId = ownershipRoot(cid);
      const root = byId.get(rootId);
      const bucket = buckets.get(rootId) || {
        ownershipRoot: rootId,
        ownershipRootName: root ? root.name : rootId,
        ownershipRootKind: root ? root.kind : "?",
        members: [],
      };
      bucket.members.push({ id: child.id, name: child.name, kind: child.kind });
      buckets.set(rootId, bucket);
    }
    const coTenants = Array.from(buckets.values()).sort((a, b) => b.members.length - a.members.length);
    perHost.push({
      host: { id: host.id, name: host.name, kind: host.kind },
      ownershipRoots: coTenants.length,
      coTenants,
    });
  }

  // Surface a one-line recommendation when ≥2 services share a host —
  // exactly the "blast radius if it fails" case that justifies this tool.
  const sharedHosts = perHost.filter((h) => h.ownershipRoots > 1);
  const summary =
    sharedHosts.length > 0
      ? `${sharedHosts.length} of ${perHost.length} host(s) carry ≥2 services — those hosts are blast-radius candidates if they fail.`
      : `No host carries more than one service besides the target — limited shared-host blast radius.`;

  const payload = {
    target: { id: found.id, name: found.name, kind: found.kind },
    hosts: perHost,
    summary,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}
