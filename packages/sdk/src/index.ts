// @thotischner/observability-mcp-sdk — public plugin SDK.
//
// This package is the published-to-npm surface plugin authors
// depend on. It mirrors the in-tree mcp-server/src/sdk/ folder
// exactly so any author can write a connector / lifecycle hook
// against the published types without cloning the whole gateway.
//
// **Vendored copy.** The canonical implementation lives in
// `mcp-server/src/sdk/`. A CI check enforces these two files
// stay byte-identical to their `mcp-server/src/sdk/` siblings.
// When you update the canonical files, copy the new contents
// here (or vice-versa) in the same commit.
//
// The longer-term plan (F20b) flips the relationship: mcp-server
// imports from this workspace package, and the duplication
// disappears. Doing the workspace setup is out of scope for the
// initial publish slice.

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

// --- Connector interface (vendored from mcp-server/src/connectors/interface.ts)
//
// Kept minimal: plugin authors only need the type to satisfy
// `export default class implements ObservabilityConnector`. The full
// in-tree interface carries more optional methods (queryMetrics,
// queryLogs, queryTraces, topology) — the published version mirrors
// those exactly. Update both when adding to the interface.

export interface ObservabilityConnector {
  readonly name: string;
  readonly type: string;
  readonly signalType: "metrics" | "logs" | "traces" | "topology";

  connect(config: unknown): Promise<void>;
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;
  disconnect(): Promise<void>;

  getDefaultMetrics(): unknown[];
  getMetrics(): unknown[];

  listServices(): Promise<unknown[]>;
  listAvailableMetrics?(service: string): Promise<unknown[]>;

  queryMetrics?(params: unknown): Promise<unknown>;
  queryLogs?(params: unknown): Promise<unknown>;
  queryTraces?(params: unknown): Promise<unknown>;

  listResources?(): Promise<unknown[]>;
  listEdges?(): Promise<unknown[]>;
  getTopologySnapshot?(): Promise<unknown>;
  watchTopology?(listener: (event: unknown) => void): () => void;
}
