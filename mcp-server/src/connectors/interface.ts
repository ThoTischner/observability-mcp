import type {
  SignalType,
  ConnectorHealth,
  ServiceInfo,
  MetricInfo,
  MetricQuery,
  MetricResult,
  LogQuery,
  LogResult,
  TraceQuery,
  TraceResult,
  SourceConfig,
  MetricDefinition,
  Resource,
  Edge,
  TopologySnapshot,
  TopologyChangeListener,
} from "../types.js";

export interface ObservabilityConnector {
  readonly name: string;
  readonly type: string;
  readonly signalType: SignalType;

  connect(config: SourceConfig): Promise<void>;
  healthCheck(): Promise<ConnectorHealth>;
  disconnect(): Promise<void>;

  /** Returns the default metric definitions for this connector type */
  getDefaultMetrics(): MetricDefinition[];

  /** Returns the active metrics (user-configured or defaults) */
  getMetrics(): MetricDefinition[];

  listServices(): Promise<ServiceInfo[]>;
  listAvailableMetrics?(service: string): Promise<MetricInfo[]>;

  queryMetrics?(params: MetricQuery): Promise<MetricResult>;
  queryLogs?(params: LogQuery): Promise<LogResult>;
  /** Optional traces capability — Tempo / Jaeger / OTLP backends
   *  implement this. The MCP `query_traces` tool fans out to every
   *  connector that has it. */
  queryTraces?(params: TraceQuery): Promise<TraceResult>;

  // --- Topology (optional capability) ---
  // Connectors that expose an infrastructure graph implement these methods.
  // Backends that only emit metrics/logs leave them undefined.

  /** Current in-memory resource list. Should be O(1) — backed by the watch cache. */
  listResources?(): Promise<Resource[]>;
  /** Current in-memory edge list. Should be O(1) — backed by the watch cache. */
  listEdges?(): Promise<Edge[]>;
  /** Atomic snapshot of resources+edges with a monotonic revision counter. */
  getTopologySnapshot?(): Promise<TopologySnapshot>;
  /** Subscribe to incremental changes. Returns an unsubscribe function. */
  watchTopology?(listener: TopologyChangeListener): () => void;
}

/** Narrowing guard: connectors that implement the topology capability. */
export function isTopologyProvider(
  c: ObservabilityConnector,
): c is ObservabilityConnector &
  Required<
    Pick<
      ObservabilityConnector,
      "listResources" | "listEdges" | "getTopologySnapshot" | "watchTopology"
    >
  > {
  return (
    typeof c.listResources === "function" &&
    typeof c.listEdges === "function" &&
    typeof c.getTopologySnapshot === "function" &&
    typeof c.watchTopology === "function"
  );
}
