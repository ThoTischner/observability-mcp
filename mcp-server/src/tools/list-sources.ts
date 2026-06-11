import type { ConnectorRegistry } from "../connectors/registry.js";
import { defaultContext, type RequestContext } from "../context.js";

export const listSourcesDefinition = {
  name: "list_sources" as const,
  description:
    "List all configured observability backends and their connection status. Use this to discover what data sources are available.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

export async function listSourcesHandler(
  registry: ConnectorRegistry,
  ctx: RequestContext = defaultContext()
) {
  const healthResults = await registry.healthCheckAll();
  // Tenant-scoped: caller only sees sources tagged with their tenant
  // plus untagged (global) sources. Pre-E7 deployments (no tenant
  // labels on any source) behave identically — every source is
  // global and visible to every tenant.
  const connectors = registry.getByTenant(ctx.tenant);

  const sources = connectors.map((c) => ({
    name: c.name,
    type: c.type,
    signalType: c.signalType,
    status: healthResults[c.name]?.status || "unknown",
    latencyMs: healthResults[c.name]?.latencyMs,
  }));

  // An empty list is ambiguous on its own — name the cause so an agent
  // doesn't read it as a transient/permission blip (the "absent ≠ zero"
  // class). When nothing is configured, say so explicitly.
  const note =
    sources.length === 0
      ? "No observability backends are configured for this tenant. Add one via the Sources tab or config/sources.yaml — this is 'none configured', not a query error."
      : undefined;

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ sources, ...(note ? { note } : {}) }, null, 2),
      },
    ],
  };
}
