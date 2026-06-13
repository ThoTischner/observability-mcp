import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ObservabilityConnector } from "./interface.js";
import type { ConnectorFactory, ConnectorManifest } from "../sdk/index.js";
import { manifestSchema } from "../sdk/manifest-schema.js";
import type { HookContext, HookPayload, HookRegistry, HookResult } from "../sdk/hooks.js";
import { PrometheusConnector } from "./prometheus.js";
import { LokiConnector } from "./loki.js";
import { KubernetesConnector } from "./kubernetes.js";
import { sanitizeForLog } from "../util/sanitize.js";
import { instrumentConnector } from "../metrics/instrument-connector.js";
import {
  loadTrustRoot,
  verifyIntegrity,
  verifyManifestSignature,
  PluginVerificationError,
} from "./verify.js";
import type { KeyObject } from "node:crypto";

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

  private disabled: Set<string>;

  // Fail-closed verification for filesystem plugins. Builtins are part
  // of the trusted image and are never gated. Default ON — operators
  // who want to load unsigned filesystem plugins must opt out with
  // VERIFY_PLUGINS=false. Without a trust root configured, no
  // filesystem plugins load (only builtins), so the demo and any
  // deployment without /app/plugins is unaffected.
  private verify: boolean;
  private trustRootPath?: string;
  private trustRoot?: KeyObject;

  /** Optional HookRegistry — when set, the loader auto-registers
   *  every entry in `manifest.hooks[]` after the plugin loads, and
   *  unregisters them when a same-name plugin replaces it. Hooks
   *  re-registered by name+kind on hot-reload (HookRegistry.register
   *  already deduplicates). */
  private hookRegistry?: HookRegistry;

  constructor(
    opts: { pluginsDir?: string; disabled?: string[]; verify?: boolean; trustRoot?: string; hookRegistry?: HookRegistry } = {}
  ) {
    this.pluginsDir = opts.pluginsDir
      ?? process.env.PLUGINS_DIR
      ?? "/app/plugins";
    this.hookRegistry = opts.hookRegistry;
    // Per-plugin disable via env: PLUGINS_DISABLED="prometheus,loki"
    const envDisabled = (process.env.PLUGINS_DISABLED ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    this.disabled = new Set([...(opts.disabled ?? []), ...envDisabled]);
    this.verify = opts.verify ?? !/^(0|false|no|off)$/i.test(process.env.VERIFY_PLUGINS ?? "true");
    this.trustRootPath = opts.trustRoot ?? process.env.PLUGIN_TRUST_ROOT;
  }

  async load(): Promise<void> {
    this.loadBuiltins();
    if (this.verify) {
      if (!this.trustRootPath) {
        console.warn(
          "VERIFY_PLUGINS is on but PLUGIN_TRUST_ROOT is unset — refusing to load any filesystem plugins (fail-closed). Builtins remain available."
        );
        return;
      }
      try {
        this.trustRoot = loadTrustRoot(this.trustRootPath);
        console.log(
          "Plugin verification enabled; trust root loaded from %s",
          sanitizeForLog(this.trustRootPath)
        );
      } catch (err) {
        console.warn(
          "VERIFY_PLUGINS is on but trust root failed to load (%s) — refusing to load any filesystem plugins (fail-closed). Builtins remain available.",
          sanitizeForLog(String(err))
        );
        return;
      }
    }
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
    return instrumentConnector(c);
  }

  private loadBuiltins(): void {
    // Builtins carry inline manifest metadata so the Installed Connectors UI
    // shows a name/description/version like filesystem plugins do (without it,
    // describeInstalled() falls back to an empty description). Mirrors
    // plugins/<name>/manifest.json — keep the description text in sync.
    this.register({
      name: "prometheus",
      source: "builtin",
      manifest: {
        schemaVersion: 1,
        name: "prometheus",
        displayName: "Prometheus",
        version: "1.0.0",
        description:
          "PromQL-based metrics backend with prom-client default scrape support and dynamic service-label resolution.",
        signalTypes: ["metrics"],
        capabilities: { queryMetrics: true, listServices: true, listAvailableMetrics: true },
      },
      factory: () => new PrometheusConnector(),
    });
    this.register({
      name: "loki",
      source: "builtin",
      manifest: {
        schemaVersion: 1,
        name: "loki",
        displayName: "Loki",
        version: "1.0.0",
        description:
          "LogQL-based log backend with dynamic service-label discovery (service_name / service / job / app / container).",
        signalTypes: ["logs"],
        capabilities: { queryLogs: true, listServices: true },
      },
      factory: () => new LokiConnector(),
    });
    this.register({
      name: "kubernetes",
      source: "builtin",
      manifest: {
        schemaVersion: 1,
        name: "kubernetes",
        displayName: "Kubernetes",
        version: "0.1.0",
        description:
          "Watches a Kubernetes cluster (in-cluster or via kubeconfig) and exposes pods, nodes, deployments, replicasets and namespaces as an infrastructure topology graph. Edges: RUNS_ON (pod→node), OWNED_BY (pod→rs→deployment), IN_NAMESPACE.",
        signalTypes: ["topology"],
      },
      factory: () => new KubernetesConnector(),
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
    let manifestPath: string | undefined;
    let manifestBytes: Buffer | undefined;
    if (marker.manifest) {
      manifestPath = resolve(pluginRoot, marker.manifest);
      if (existsSync(manifestPath)) {
        manifestBytes = readFileSync(manifestPath);
        const raw = JSON.parse(manifestBytes.toString("utf8"));
        const parsed = manifestSchema.safeParse(raw);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
          console.warn(
            "Plugin %s has invalid manifest.json — %s; skipping",
            sanitizeForLog(marker.name),
            sanitizeForLog(issues)
          );
          return;
        }
        manifest = parsed.data;
        if (manifest.name !== marker.name) {
          console.warn(
            "Plugin %s package.json marker name does not match manifest.json (%s); skipping",
            sanitizeForLog(marker.name),
            sanitizeForLog(manifest.name)
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

    // Fail-closed verification gate. A plugin only loads under
    // VERIFY_PLUGINS if it ships a manifest whose `integrity` matches
    // the entry file AND a detached `<manifest>.sig` that verifies
    // against the trust root. Everything is local — airgapped-safe.
    if (this.verify) {
      if (!manifest || !manifestPath || !manifestBytes) {
        console.warn(
          "VERIFY_PLUGINS: plugin %s has no manifest.json — skipping (fail-closed)",
          sanitizeForLog(marker.name)
        );
        return;
      }
      const sigPath = manifestPath + ".sig";
      if (!existsSync(sigPath)) {
        console.warn(
          "VERIFY_PLUGINS: plugin %s missing manifest signature %s — skipping (fail-closed)",
          sanitizeForLog(marker.name),
          sanitizeForLog(marker.manifest + ".sig")
        );
        return;
      }
      try {
        verifyManifestSignature(manifestBytes, readFileSync(sigPath), this.trustRoot!);
        verifyIntegrity(entryPath, manifest.integrity);
      } catch (err) {
        const detail =
          err instanceof PluginVerificationError ? err.message : String(err);
        console.warn(
          "VERIFY_PLUGINS: plugin %s failed verification (%s) — skipping (fail-closed)",
          sanitizeForLog(marker.name),
          sanitizeForLog(detail)
        );
        return;
      }
      console.log(
        "VERIFY_PLUGINS: plugin %s signature + integrity OK",
        sanitizeForLog(marker.name)
      );
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
    // Manifest-driven hook auto-registration (Q10). After the
    // entry module loads (and is integrity/sig-verified above), walk
    // manifest.hooks[] and resolve each entry's `module` against the
    // plugin root. Default export is the handler. Errors during
    // individual hook load are logged + skipped — they don't tear
    // down the connector itself.
    if (this.hookRegistry && manifest?.hooks?.length) {
      // Drop any prior registrations for this plugin so a hot-reload
      // doesn't leave stale entries side-by-side with new ones.
      this.hookRegistry.unregisterPlugin(marker.name);
      for (const hookEntry of manifest.hooks) {
        const hookPath = resolve(pluginRoot, hookEntry.module);
        const inside = hookPath.startsWith(resolve(pluginRoot) + "/") || hookPath === resolve(pluginRoot);
        if (!inside) {
          console.warn(
            "Plugin %s hook module %s escapes the plugin root — skipping",
            sanitizeForLog(marker.name),
            sanitizeForLog(hookEntry.module),
          );
          continue;
        }
        if (!existsSync(hookPath)) {
          console.warn(
            "Plugin %s hook module %s not found — skipping",
            sanitizeForLog(marker.name),
            sanitizeForLog(hookEntry.module),
          );
          continue;
        }
        try {
          const hookMod = await import(pathToFileURL(hookPath).href);
          const handler = hookMod.default ?? hookMod.handler;
          if (typeof handler !== "function") {
            console.warn(
              "Plugin %s hook module %s has no default export — skipping",
              sanitizeForLog(marker.name),
              sanitizeForLog(hookEntry.module),
            );
            continue;
          }
          this.hookRegistry.register({
            pluginName: marker.name,
            kind: hookEntry.kind,
            priority: hookEntry.priority,
            mode: hookEntry.mode,
            handler: handler as (ctx: HookContext, payload: HookPayload) => Promise<HookResult> | HookResult,
          });
          console.log(
            'Plugin "%s": registered %s hook from %s',
            sanitizeForLog(marker.name),
            sanitizeForLog(hookEntry.kind),
            sanitizeForLog(hookEntry.module),
          );
        } catch (err) {
          console.warn(
            "Plugin %s hook %s/%s failed to load: %s",
            sanitizeForLog(marker.name),
            sanitizeForLog(hookEntry.kind),
            sanitizeForLog(hookEntry.module),
            sanitizeForLog(err instanceof Error ? err.message : String(err)),
          );
        }
      }
    }
    console.log(
      'Connector plugin "%s" loaded from %s',
      sanitizeForLog(marker.name),
      sanitizeForLog(pluginRoot)
    );
  }

  private register(entry: LoadedConnector): void {
    if (this.disabled.has(entry.name)) {
      console.log("Connector %s disabled via PLUGINS_DISABLED; skipping", sanitizeForLog(entry.name));
      return;
    }
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
