import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import type { Config, SourceConfig, GeneralSettings, HealthThresholds } from "../types.js";

function resolveConfigPath(): string {
  if (process.env.CONFIG_PATH) return process.env.CONFIG_PATH;
  const localPath = "./config/sources.yaml";
  if (existsSync(localPath)) return localPath;
  return join(homedir(), ".observability-mcp", "sources.yaml");
}

const CONFIG_PATH = resolveConfigPath();

export const DEFAULT_SETTINGS: GeneralSettings = {
  checkIntervalMs: 30000,
  defaultSensitivity: "medium",
};

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  weights: { errorRate: 0.35, latency: 0.25, cpu: 0.20, logErrors: 0.20 },
  cpu: { good: 50, warn: 80, crit: 95 },
  errorRate: { good: 0.01, warn: 0.1, crit: 0.5 },
  latencyP99: { good: 0.5, warn: 1.0, crit: 3.0 },
  logErrors: { good: 1, warn: 5, crit: 20 },
  statusBoundaries: { healthy: 80, degraded: 50 },
};

export function substituteEnv(raw: string): string {
  return raw.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/gi, (_match, name, fallback) => {
    const val = process.env[name];
    if (val !== undefined) return val;
    if (fallback !== undefined) return fallback;
    console.warn(`[config] env var \${${name}} is undefined`);
    return "";
  });
}

export function loadConfig(): Config {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = yaml.load(substituteEnv(raw)) as Partial<Config>;
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

function parseUrlList(envVar: string | undefined, type: string): SourceConfig[] {
  if (!envVar) return [];
  return envVar.split(",").map((url, i, arr) => ({
    name: arr.length === 1 ? type : `${type}-${i + 1}`,
    type,
    url: url.trim(),
    enabled: true,
  }));
}

function buildConfigFromEnv(): Config {
  const sources: SourceConfig[] = [
    ...parseUrlList(process.env.PROMETHEUS_URL, "prometheus"),
    ...parseUrlList(process.env.LOKI_URL, "loki"),
  ];
  return {
    sources,
    settings: { ...DEFAULT_SETTINGS },
    healthThresholds: DEFAULT_HEALTH_THRESHOLDS,
  };
}

export function saveConfig(config: Config): void {
  const dir = dirname(CONFIG_PATH);
  mkdirSync(dir, { recursive: true });
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
