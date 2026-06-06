// Public plugin SDK — the surface a connector author depends on.
//
// Plugins should import only from this path so internal refactors of
// mcp-server stay invisible to them. This file is intentionally a
// re-export barrel — keep behaviour out of it.
//
// Stability: while still on 0.x of the plugin contract, breaking changes
// may happen. Each release of mcp-server publishes a sibling
// `@thotischner/observability-mcp-sdk` package mirroring this surface,
// pinned to the same version. Plugins should declare a peer/range
// against that package and an `observabilityMcp.compat.serverVersion`
// constraint in their package.json (see docs/plugin-architecture.md).

export type { ObservabilityConnector } from "../connectors/interface.js";
export { manifestSchema } from "./manifest-schema.js";
export type { ValidatedConnectorManifest } from "./manifest-schema.js";
export { HookRegistry } from "./hooks.js";
export type {
  HookKind,
  HookContext,
  HookPayload,
  HookResult,
  HookRegistration,
} from "./hooks.js";

export type {
  SignalType,
  SourceConfig,
  SourceAuth,
  SourceTls,
  ConnectorHealth,
  ServiceInfo,
  MetricInfo,
  MetricQuery,
  MetricResult,
  MetricSummary,
  DataPoint,
  LogQuery,
  LogResult,
  LogEntry,
  LogSummary,
  MetricDefinition,
  Resource,
  Edge,
  TopologySnapshot,
  TopologyChangeEvent,
  TopologyChangeListener,
} from "../types.js";

/**
 * Manifest shape declared in a plugin's `manifest.json`. The server
 * validates plugin manifests against this at load time.
 *
 * @see docs/plugin-architecture.md
 */
export interface ConnectorManifest {
  /** Manifest format version. Always 1 today. */
  schemaVersion: 1;
  /** Connector type id, e.g. "prometheus". Used in sources.yaml `type:`. */
  name: string;
  /** Human-readable name shown in the Web UI / hub. */
  displayName: string;
  /** Semver of this connector build. */
  version: string;
  description: string;
  signalTypes: Array<"metrics" | "logs" | "traces" | "topology">;
  homepage?: string;
  license?: string;
  logo?: string;
  /** JSON Schema describing this connector's `SourceConfig` payload. */
  configSchema?: unknown;
  capabilities?: {
    queryMetrics?: boolean;
    queryLogs?: boolean;
    listServices?: boolean;
    listAvailableMetrics?: boolean;
  };
  compat?: {
    /** Semver range of mcp-server versions this connector supports. */
    serverVersion?: string;
  };
  /**
   * Subresource-integrity-style digest of the entry file
   * ("sha256-<base64>"). Required (and signature-checked) when the
   * server runs with VERIFY_PLUGINS=true. See docs/plugin-architecture.md.
   */
  integrity?: string;
  /**
   * Lifecycle hooks the plugin wants auto-registered on load. Each
   * entry points to a module path INSIDE the plugin's bundled files;
   * the loader imports its default export and registers it on the
   * gateway's HookRegistry. Mirrors the Zod manifestSchema in
   * mcp-server/src/sdk/manifest-schema.ts. See Q10 / phase-q-sprint.md.
   */
  hooks?: Array<{
    kind: "tool_pre_invoke" | "tool_post_invoke" | "resource_pre_fetch" | "resource_post_fetch" | "prompt_pre_fetch" | "prompt_post_fetch";
    module: string;
    priority?: number;
    mode?: "enforce" | "permissive" | "disabled";
  }>;
}

/**
 * The default export shape a connector plugin module must provide.
 *
 * @example
 *   import type { ObservabilityConnector, ConnectorFactory } from "@thotischner/observability-mcp-sdk";
 *   const create: ConnectorFactory = () => new MyConnector();
 *   export default create;
 */
export type ConnectorFactory = () =>
  | import("../connectors/interface.js").ObservabilityConnector
  | Promise<import("../connectors/interface.js").ObservabilityConnector>;
