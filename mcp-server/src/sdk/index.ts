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
  signalTypes: Array<"metrics" | "logs" | "traces">;
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
