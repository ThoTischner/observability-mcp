import type { ConnectorRegistry } from "../connectors/registry.js";

export const listSourcesDefinition = {
  name: "list_sources" as const,
  description:
    "List all configured observability backends and their connection status. Use this to discover what data sources are available.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

export async function listSourcesHandler(registry: ConnectorRegistry) {
  const healthResults = await registry.healthCheckAll();
  const connectors = registry.getAll();

  const sources = connectors.map((c) => ({
    name: c.name,
    type: c.type,
    signalType: c.signalType,
    status: healthResults[c.name]?.status || "unknown",
    latencyMs: healthResults[c.name]?.latencyMs,
  }));

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ sources }, null, 2),
      },
    ],
  };
}
