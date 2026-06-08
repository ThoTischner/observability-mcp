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

/** A Prometheus/Loki label name: letter/underscore, then word chars. */
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validate a structured `labels` filter map for query_logs. Fail-closed:
 * any bad key/value rejects the whole request rather than silently
 * dropping a filter (a dropped filter could widen results past what the
 * caller intended). Bounds the map size + value length so a crafted input
 * can't build a pathological query.
 */
export function validateLogLabels(labels: unknown): string | null {
  if (labels === undefined) return null;
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)) {
    return "Invalid labels: must be an object mapping label names to string values.";
  }
  const entries = Object.entries(labels as Record<string, unknown>);
  if (entries.length > 20) {
    return "Too many labels (max 20).";
  }
  for (const [k, v] of entries) {
    if (!LABEL_NAME_RE.test(k)) {
      return `Invalid label name "${k}". Must match [a-zA-Z_][a-zA-Z0-9_]* (no dots, dashes, or quotes).`;
    }
    if (typeof v !== "string") {
      return `Invalid value for label "${k}": must be a string.`;
    }
    if (v.length > 1024) {
      return `Value for label "${k}" too long (max 1024 chars).`;
    }
  }
  return null;
}

export function errorResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}
