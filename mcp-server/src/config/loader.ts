import { readFileSync, writeFileSync } from "node:fs";
import yaml from "js-yaml";
import type { Config, SourceConfig, GeneralSettings, HealthThresholds } from "../types.js";

const CONFIG_PATH = process.env.CONFIG_PATH || "./config/sources.yaml";

export const DEFAULT_SETTINGS: GeneralSettings = {
  checkIntervalMs: 30000,
  defaultSensitivity: "medium",
  ollamaUrl: "http://host.docker.internal:11434",
  ollamaModel: "llama3.1:8b",
  systemPrompt: `You are an SRE agent monitoring microservices infrastructure. When observability data shows anomalies or issues:

1. Identify which service(s) are affected and what signals are abnormal
2. Determine the likely root cause based on the metric patterns and correlations
3. Assess severity: P1 (critical, user-facing outage), P2 (degraded, partial impact), P3 (warning, needs attention), P4 (informational)
4. Suggest specific, actionable remediation steps

Be concise and structured. Use the available MCP tools to gather more data if needed.`,
};

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  weights: { errorRate: 0.35, latency: 0.25, cpu: 0.20, logErrors: 0.20 },
  cpu: { good: 50, warn: 80, crit: 95 },
  errorRate: { good: 0.01, warn: 0.1, crit: 0.5 },
  latencyP99: { good: 0.5, warn: 1.0, crit: 3.0 },
  logErrors: { good: 1, warn: 5, crit: 20 },
  statusBoundaries: { healthy: 80, degraded: 50 },
};

export function loadConfig(): Config {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = yaml.load(raw) as Partial<Config>;
    return {
      sources: parsed?.sources || [],
      settings: { ...DEFAULT_SETTINGS, ...parsed?.settings },
      healthThresholds: deepMerge(DEFAULT_HEALTH_THRESHOLDS, (parsed?.healthThresholds || {}) as Partial<HealthThresholds>),
    };
  } catch {
    console.warn(`Config file not found at ${CONFIG_PATH}, using env vars + defaults`);
    return buildConfigFromEnv();
  }
}

function buildConfigFromEnv(): Config {
  const sources: SourceConfig[] = [];
  if (process.env.PROMETHEUS_URL) {
    sources.push({ name: "prometheus", type: "prometheus", url: process.env.PROMETHEUS_URL, enabled: true });
  }
  if (process.env.LOKI_URL) {
    sources.push({ name: "loki", type: "loki", url: process.env.LOKI_URL, enabled: true });
  }
  return {
    sources,
    settings: {
      ...DEFAULT_SETTINGS,
      ollamaUrl: process.env.OLLAMA_URL || DEFAULT_SETTINGS.ollamaUrl,
      ollamaModel: process.env.OLLAMA_MODEL || DEFAULT_SETTINGS.ollamaModel,
    },
    healthThresholds: DEFAULT_HEALTH_THRESHOLDS,
  };
}

export function saveConfig(config: Config): void {
  const yamlStr = yaml.dump(config, { indent: 2, lineWidth: 200 });
  writeFileSync(CONFIG_PATH, yamlStr, "utf-8");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMerge<T extends Record<string, any>>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as Array<keyof T>) {
    const val = override[key];
    if (val && typeof val === "object" && !Array.isArray(val) && typeof base[key] === "object") {
      result[key] = deepMerge(base[key], val);
    } else if (val !== undefined) {
      result[key] = val as T[keyof T];
    }
  }
  return result;
}
