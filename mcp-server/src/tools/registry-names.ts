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
  "get_service_health",
  "detect_anomalies",
  "get_topology",
  "get_blast_radius",
] as const;

export type RegisteredToolName = typeof REGISTERED_TOOL_NAMES[number];

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
