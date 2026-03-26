import type { ConnectorRegistry } from "../connectors/registry.js";
import type { ServiceInfo } from "../types.js";

export const listServicesDefinition = {
  name: "list_services" as const,
  description:
    "List all monitored services discovered across all connected backends. Returns service names, their data sources, and signal types (metrics/logs).",
  inputSchema: {
    type: "object" as const,
    properties: {
      filter: {
        type: "string",
        description: "Optional filter to match service names",
      },
    },
  },
};

export async function listServicesHandler(
  registry: ConnectorRegistry,
  args: { filter?: string }
) {
  const connectors = registry.getAll();
  const allServices: ServiceInfo[] = [];

  for (const connector of connectors) {
    try {
      const services = await connector.listServices();
      allServices.push(...services);
    } catch (err) {
      console.error(`Failed to list services from ${connector.name}:`, err);
    }
  }

  // Deduplicate by name, merge signal types
  const merged = new Map<string, { name: string; sources: string[]; signalTypes: string[] }>();
  for (const svc of allServices) {
    const existing = merged.get(svc.name);
    if (existing) {
      if (!existing.sources.includes(svc.source)) existing.sources.push(svc.source);
      if (!existing.signalTypes.includes(svc.signalType))
        existing.signalTypes.push(svc.signalType);
    } else {
      merged.set(svc.name, {
        name: svc.name,
        sources: [svc.source],
        signalTypes: [svc.signalType],
      });
    }
  }

  let services = Array.from(merged.values());
  if (args.filter) {
    const f = args.filter.toLowerCase();
    services = services.filter((s) => s.name.toLowerCase().includes(f));
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ services, total: services.length }, null, 2),
      },
    ],
  };
}
