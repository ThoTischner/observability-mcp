/**
 * Canonical list of MCP tool names exposed by createMcpServer().
 *
 * Used by:
 *   - the Product validator (typo guard): a Product's `tools` allow-
 *     list must reference names that actually register, otherwise a
 *     bound credential opens an /mcp session with an empty tool set
 *     and the agent silently fails.
 *   - the keystone integration test in registry-names.test.ts that
 *     reads index.ts and asserts the registerTool() call sites match
 *     this list 1:1 — a missing entry or an extra one trips the test.
 *
 * Keep this list and the registerTool("name", ...) calls in
 * createMcpServer in sync. The test enforces it.
 */
export const REGISTERED_TOOL_NAMES = [
  "list_sources",
  "list_services",
  "query_metrics",
  "query_logs",
  "query_traces",
  "get_service_health",
  "detect_anomalies",
  "get_topology",
  "get_blast_radius",
] as const;

export type RegisteredToolName = typeof REGISTERED_TOOL_NAMES[number];

/** Functional category of a tool, surfaced in /api/tools/registry and
 *  used by the Products UI to group the multi-select picker. Keeps
 *  operator-facing taxonomy stable even when tool descriptions evolve. */
export type ToolCategory = "discovery" | "query" | "diagnose" | "topology";

export interface ToolRegistryEntry {
  name: RegisteredToolName;
  category: ToolCategory;
  /** One-liner — what the tool does, no fluff. The full multi-paragraph
   *  description lives in createMcpServer's registerTool() call; this
   *  is the catalogue summary the picker shows alongside the name. */
  summary: string;
}

export const REGISTERED_TOOLS: readonly ToolRegistryEntry[] = [
  { name: "list_sources",       category: "discovery", summary: "List configured observability backends + reachability." },
  { name: "list_services",      category: "discovery", summary: "Discover service names across every connected backend." },
  { name: "query_metrics",      category: "query",     summary: "Fetch the raw time-series for one metric of one service over a window." },
  { name: "query_logs",         category: "query",     summary: "Fetch matching log lines for one service over a window." },
  { name: "query_traces",       category: "query",     summary: "Fetch ranked trace summaries for one service over a window." },
  { name: "get_service_health", category: "diagnose",  summary: "Aggregated health verdict for one service (metrics + logs)." },
  { name: "detect_anomalies",   category: "diagnose",  summary: "Scan for anomalous services using z-score / heuristics." },
  { name: "get_topology",       category: "topology",  summary: "Return the infrastructure topology graph (resources + edges)." },
  { name: "get_blast_radius",   category: "topology",  summary: "Given a resource, return the impact set if its host(s) fail." },
] as const;

/** Validate a candidate Product tools[] array. Returns the unknown
 *  names (empty array = all OK). Pure helper — the caller decides
 *  how to surface the rejection (the API handler emits a 422 with a
 *  hint of valid names; the YAML loader could decide to warn). */
export function unknownToolNames(tools: readonly string[]): string[] {
  const known = new Set<string>(REGISTERED_TOOL_NAMES);
  const out: string[] = [];
  for (const t of tools) {
    if (!known.has(t)) out.push(t);
  }
  return out;
}
