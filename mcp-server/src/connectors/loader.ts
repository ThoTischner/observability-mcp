import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ObservabilityConnector } from "./interface.js";
import type { ConnectorFactory, ConnectorManifest } from "../sdk/index.js";
import { PrometheusConnector } from "./prometheus.js";
import { LokiConnector } from "./loki.js";
import { sanitizeForLog } from "../util/sanitize.js";

export interface LoadedConnector {
  /** Connector type id, e.g. "prometheus". Matches `source.type` in sources.yaml. */
  name: string;
  /** Where this connector came from (debug + UI display). */
  source: "builtin" | "filesystem" | "config";
  /** Optional metadata for plugins that ship a manifest.json. */
  manifest?: ConnectorManifest;
  factory: ConnectorFactory;
}

/**
 * Resolves which connector implementations the server should know about,
 * applying three sources in order (later overrides earlier):
 *   1. builtin shim — Prometheus/Loki bundled with the server
 *   2. filesystem  — every subdir of PLUGINS_DIR with a valid package.json
 *   3. config-pinned — `plugins:` block in sources.yaml (not yet wired)
 *
 * The legacy `connectorFactories` map in registry.ts can be replaced
 * with this loader's output without changing observable behaviour.
 */
export class PluginLoader {
  private connectors = new Map<string, LoadedConnector>();
  private pluginsDir: string;

  constructor(opts: { pluginsDir?: string } = {}) {
    this.pluginsDir = opts.pluginsDir
      ?? process.env.PLUGINS_DIR
      ?? "/app/plugins";
  }

  async load(): Promise<void> {
    this.loadBuiltins();
    await this.loadFilesystem();
  }

  list(): LoadedConnector[] {
    return Array.from(this.connectors.values());
  }

  get(name: string): LoadedConnector | undefined {
    return this.connectors.get(name);
  }

  has(name: string): boolean {
    return this.connectors.has(name);
  }

  supportedTypes(): string[] {
    return Array.from(this.connectors.keys());
  }

  /** Create a fresh instance of a connector. Returns undefined for unknown types. */
  create(name: string): ObservabilityConnector | undefined {
    const entry = this.connectors.get(name);
    if (!entry) return undefined;
    const c = entry.factory();
    if (c instanceof Promise) {
      // For now connectors are sync-constructed; if a plugin returns a
      // Promise we await it lazily in the consumer. Document if/when
      // this becomes a real pattern.
      throw new Error(`Connector ${name} returned a Promise; async factories not yet wired`);
    }
    return c;
  }

  private loadBuiltins(): void {
    this.register({
      name: "prometheus",
      source: "builtin",
      factory: () => new PrometheusConnector(),
    });
    this.register({
      name: "loki",
      source: "builtin",
      factory: () => new LokiConnector(),
    });
  }

  private async loadFilesystem(): Promise<void> {
    const dir = this.pluginsDir;
    if (!existsSync(dir)) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const pluginRoot = join(dir, entry);
      try {
        if (!statSync(pluginRoot).isDirectory()) continue;
        await this.loadFilesystemPlugin(pluginRoot);
      } catch (err) {
        console.warn("Failed to load plugin %s: %s", sanitizeForLog(entry), sanitizeForLog(String(err)));
      }
    }
  }

  private async loadFilesystemPlugin(pluginRoot: string): Promise<void> {
    const pkgPath = join(pluginRoot, "package.json");
    if (!existsSync(pkgPath)) return;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      main?: string;
      observabilityMcp?: { kind?: string; name?: string; manifest?: string };
    };
    const marker = pkg.observabilityMcp;
    if (!marker || marker.kind !== "connector" || !marker.name) return;

    let manifest: ConnectorManifest | undefined;
    if (marker.manifest) {
      const manifestPath = resolve(pluginRoot, marker.manifest);
      if (existsSync(manifestPath)) {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ConnectorManifest;
        if (manifest.schemaVersion !== 1) {
          console.warn(
            "Plugin %s declares unsupported manifest schemaVersion %s; skipping",
            sanitizeForLog(marker.name),
            sanitizeForLog(String(manifest.schemaVersion))
          );
          return;
        }
      }
    }

    const entryFile = pkg.main || "index.js";
    const entryPath = resolve(pluginRoot, entryFile);
    if (!existsSync(entryPath)) {
      console.warn("Plugin %s missing entry file %s", sanitizeForLog(marker.name), sanitizeForLog(entryFile));
      return;
    }
    const mod = await import(pathToFileURL(entryPath).href);
    const factory: ConnectorFactory | undefined = mod.default ?? mod.createConnector;
    if (typeof factory !== "function") {
      console.warn("Plugin %s has no default export factory", sanitizeForLog(marker.name));
      return;
    }
    this.register({
      name: marker.name,
      source: "filesystem",
      manifest,
      factory,
    });
    console.log(
      'Connector plugin "%s" loaded from %s',
      sanitizeForLog(marker.name),
      sanitizeForLog(pluginRoot)
    );
  }

  private register(entry: LoadedConnector): void {
    // Later sources override earlier ones; current call order is
    // builtin → filesystem → config-pinned, matching the design doc.
    this.connectors.set(entry.name, entry);
  }
}

/**
 * Singleton loader populated at server startup. The registry consults
 * this for connector creation. Tests may swap in their own instance
 * with `setPluginLoader`.
 */
let activeLoader: PluginLoader | null = null;

export function getPluginLoader(): PluginLoader {
  if (!activeLoader) activeLoader = new PluginLoader();
  return activeLoader;
}

export function setPluginLoader(loader: PluginLoader): void {
  activeLoader = loader;
}
