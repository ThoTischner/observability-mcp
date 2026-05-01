import type { ConnectorRegistry } from "../connectors/registry.js";

const DURATION_RE = /^\d+[mhd]$/;
// Slashes are valid in Prometheus label values and appear in real-world job
// names (Grafana Cloud Integrations like "integrations/unix", k8s namespaces,
// Docker image refs). The PromQL/LogQL injection surface is the surrounding
// quote/backslash, which we escape separately, not these characters.
const SAFE_LABEL_RE = /^[a-zA-Z0-9_\-.:/]+$/;

export function validateDuration(duration: string): string | null {
  if (!DURATION_RE.test(duration)) {
    return `Invalid duration "${duration}". Expected format: <number><unit> where unit is m (minutes), h (hours), or d (days). Examples: 5m, 1h, 24h, 7d`;
  }
  return null;
}

export function validateMetricName(metric: string, registry: ConnectorRegistry): string | null {
  const allMetrics = new Set<string>();
  for (const c of registry.getBySignal("metrics")) {
    for (const m of c.getMetrics()) allMetrics.add(m.name);
  }
  if (allMetrics.size > 0 && !allMetrics.has(metric)) {
    return `Unknown metric "${metric}". Available metrics: ${[...allMetrics].join(", ")}`;
  }
  return null;
}

/**
 * Sanitize a label value for use in PromQL/LogQL queries.
 * Only allows alphanumeric, hyphens, underscores, dots, colons.
 * Rejects anything that could be used for injection.
 */
export function sanitizeLabelValue(value: string): string | null {
  if (!value || value.length > 128) {
    return null;
  }
  if (!SAFE_LABEL_RE.test(value)) {
    return null;
  }
  return value;
}

export function validateServiceName(service: string): string | null {
  if (!sanitizeLabelValue(service)) {
    return `Invalid service name "${service}". Only alphanumeric characters, hyphens, underscores, dots, colons, and slashes are allowed (max 128 chars).`;
  }
  return null;
}

export function errorResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}
