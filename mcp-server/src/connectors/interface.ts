import type {
  SignalType,
  ConnectorHealth,
  ServiceInfo,
  MetricInfo,
  MetricQuery,
  MetricResult,
  LogQuery,
  LogResult,
  SourceConfig,
  MetricDefinition,
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
}
