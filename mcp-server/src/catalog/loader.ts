/**
 * Service catalog: an operator-curated map of service name → ownership /
 * criticality / on-call metadata. Hooked into the existing /api/services
 * and /api/health responses so the UI (and the agent through the MCP
 * tools that derive from those endpoints) can see "this is owned by
 * team-payments, criticality tier-1, on-call URL …" without having to
 * cross-reference an external CMDB.
 *
 * On-disk format: JSON file (commit-friendly, easy to diff in PRs). Path
 * defaults to `mcp-server/config/catalog.json`; override via
 * `OMCP_SERVICE_CATALOG_FILE`. Missing or malformed file => no catalog
 * (the server boots fine, enrichment is a no-op).
 *
 * Distinct from the enterprise-gate `OMCP_CATALOG` "product catalog"
 * which lives behind the entitlement gate and governs MCP-tool grants —
 * different trust model, different schema.
 */

import { promises as fs } from "node:fs";

export type CriticalityTier = "tier-1" | "tier-2" | "tier-3" | "tier-4";
export type DataClassification = "public" | "internal" | "confidential" | "restricted";

export interface ServiceCatalogEntry {
  /** Stable short owner identifier — team slug, squad, individual handle. */
  owner?: string;
  /** Human-readable description. One sentence. */
  description?: string;
  /** Page-the-team URL — Slack channel, on-call rota, runbook index. */
  onCall?: string;
  /** Operator-defined criticality bucket. */
  tier?: CriticalityTier;
  /** Data classification of what flows through the service. */
  dataClassification?: DataClassification;
  /** Free-form SLO label ("99.9% / month" / "99.5%"). Not parsed. */
  slo?: string;
  /** Optional list of relevant runbook URLs. */
  runbooks?: string[];
  /** Optional list of free-form tags. */
  tags?: string[];
  /** Tenant the entry belongs to. Omitted → "default". Used by
   *  multi-tenant deployments to scope what /api/catalog and the
   *  list_services / get_service_health tools surface per session. */
  tenant?: string;
}

export interface ServiceCatalog {
  /** Map service name → entry. Service-name key is the same string
   * `list_services` returns; no fuzzy matching. */
  services: Record<string, ServiceCatalogEntry>;
}

const EMPTY_CATALOG: ServiceCatalog = { services: {} };
const VALID_TIERS = new Set<CriticalityTier>(["tier-1", "tier-2", "tier-3", "tier-4"]);
const VALID_CLASS = new Set<DataClassification>(["public", "internal", "confidential", "restricted"]);

/** Read + validate a catalog file. Returns the empty catalog on any
 * problem and (when configured) emits a single warn-level console.error
 * so the operator notices but the server keeps booting. */
export async function readCatalogFile(path: string | undefined): Promise<ServiceCatalog> {
  if (!path) return EMPTY_CATALOG;
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch {
    return EMPTY_CATALOG;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`[catalog] OMCP_SERVICE_CATALOG_FILE=${path} is not valid JSON: ${(e as Error).message}`);
    return EMPTY_CATALOG;
  }
  return validateCatalog(parsed);
}

/** Pure validator — useful in tests and when feeding in-memory data. */
export function validateCatalog(input: unknown): ServiceCatalog {
  if (!input || typeof input !== "object") return EMPTY_CATALOG;
  const obj = input as Record<string, unknown>;
  const rawServices = obj.services;
  if (!rawServices || typeof rawServices !== "object") return EMPTY_CATALOG;
  const out: Record<string, ServiceCatalogEntry> = {};
  for (const [name, value] of Object.entries(rawServices as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const e = value as Record<string, unknown>;
    const entry: ServiceCatalogEntry = {};
    if (typeof e.owner === "string") entry.owner = e.owner;
    if (typeof e.description === "string") entry.description = e.description;
    if (typeof e.onCall === "string") entry.onCall = e.onCall;
    if (typeof e.tier === "string" && VALID_TIERS.has(e.tier as CriticalityTier)) {
      entry.tier = e.tier as CriticalityTier;
    }
    if (typeof e.dataClassification === "string" && VALID_CLASS.has(e.dataClassification as DataClassification)) {
      entry.dataClassification = e.dataClassification as DataClassification;
    }
    if (typeof e.slo === "string") entry.slo = e.slo;
    if (Array.isArray(e.runbooks)) {
      entry.runbooks = e.runbooks.filter((x): x is string => typeof x === "string");
    }
    if (Array.isArray(e.tags)) {
      entry.tags = e.tags.filter((x): x is string => typeof x === "string");
    }
    if (typeof e.tenant === "string") entry.tenant = e.tenant;
    out[name] = entry;
  }
  return { services: out };
}

/** Lookup wrapper used by the enricher / API handlers. */
export class CatalogStore {
  constructor(private catalog: ServiceCatalog = EMPTY_CATALOG) {}
  /** Lookup. When `tenant` is set, returns undefined for entries
   *  belonging to a different tenant — so a cross-tenant
   *  enrichment never leaks owner / on-call / SLO bytes. Entries
   *  without a tenant field are treated as `"default"`. */
  get(serviceName: string, tenant?: string): ServiceCatalogEntry | undefined {
    const e = this.catalog.services[serviceName];
    if (!e) return undefined;
    if (!tenant) return e;
    const entryTenant = e.tenant || "default";
    return entryTenant === tenant ? e : undefined;
  }
  /** Snapshot. When `tenant` is set, filters down to entries in that
   *  tenant; entries without a tenant field counted as `"default"`. */
  list(tenant?: string): Record<string, ServiceCatalogEntry> {
    if (!tenant) return this.catalog.services;
    const out: Record<string, ServiceCatalogEntry> = {};
    for (const [k, v] of Object.entries(this.catalog.services)) {
      if ((v.tenant || "default") === tenant) out[k] = v;
    }
    return out;
  }
  count(tenant?: string): number {
    return Object.keys(this.list(tenant)).length;
  }
  replace(catalog: ServiceCatalog): void {
    this.catalog = catalog;
  }
}
