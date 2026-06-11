import type { ConnectorRegistry } from "../connectors/registry.js";
import type { ServiceInfo } from "../types.js";
import { defaultContext, type RequestContext } from "../context.js";

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
  args: { filter?: string },
  ctx: RequestContext = defaultContext()
) {
  // Tenant-scoped: only consult sources the caller can see.
  const connectors = registry.getByTenant(ctx.tenant);
  const allServices: ServiceInfo[] = [];
  // Track per-connector discovery failures so an empty result isn't silently
  // partial — a down source must not make half the fleet vanish without a
  // signal (the "absent ≠ zero" class, cf. #453).
  const failedSources: string[] = [];

  for (const connector of connectors) {
    try {
      const services = await connector.listServices();
      allServices.push(...services);
    } catch (err) {
      console.error(`Failed to list services from ${connector.name}:`, err);
      failedSources.push(connector.name);
    }
  }

  // Deduplicate by name, merge signal types. Carry per-service `labels`
  // (e.g. the Loki connector's `discoveredVia`, documented in docs/loki.md)
  // through the merge so discovery metadata actually surfaces in the tool
  // output; first source to set a given label key wins.
  const merged = new Map<
    string,
    { name: string; sources: string[]; signalTypes: string[]; labels?: Record<string, string> }
  >();
  for (const svc of allServices) {
    const existing = merged.get(svc.name);
    if (existing) {
      if (!existing.sources.includes(svc.source)) existing.sources.push(svc.source);
      if (!existing.signalTypes.includes(svc.signalType))
        existing.signalTypes.push(svc.signalType);
      if (svc.labels) existing.labels = { ...svc.labels, ...(existing.labels ?? {}) };
    } else {
      merged.set(svc.name, {
        name: svc.name,
        sources: [svc.source],
        signalTypes: [svc.signalType],
        labels: svc.labels ? { ...svc.labels } : undefined,
      });
    }
  }

  let services = Array.from(merged.values());
  if (args.filter) {
    const f = args.filter.toLowerCase();
    services = services.filter((s) => s.name.toLowerCase().includes(f));
  }

  // An empty result is ambiguous — say *why* so an agent doesn't read it as
  // "this environment has no services". Distinguish: no backends configured,
  // discovery failed on some/all sources, or genuinely none discovered.
  let note: string | undefined;
  if (connectors.length === 0) {
    note = "No observability backends are configured for this tenant — add one via the Sources tab or config/sources.yaml. This is not 'zero services'.";
  } else if (failedSources.length === connectors.length) {
    note = `Service discovery failed on all ${connectors.length} configured source(s) (${failedSources.join(", ")}) — the empty result is an error, not 'zero services'. Check source health via list_sources.`;
  } else if (services.length === 0 && !args.filter) {
    note = "No services discovered — the configured backend(s) returned none in this tenant.";
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            services,
            total: services.length,
            // Only present when some (but not all) sources failed — a partial
            // result the caller should know is incomplete.
            ...(failedSources.length > 0 && failedSources.length < connectors.length
              ? { partial: true, failedSources }
              : {}),
            ...(note ? { note } : {}),
          },
          null,
          2,
        ),
      },
    ],
  };
}
