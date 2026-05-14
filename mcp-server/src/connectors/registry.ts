import type { ObservabilityConnector } from "./interface.js";
import type { Config, ConnectorHealth, SignalType, SourceConfig } from "../types.js";
import { getPluginLoader, type PluginLoader } from "./loader.js";
import { sanitizeForLog } from "../util/sanitize.js";

export function getSupportedTypes(): string[] {
  return getPluginLoader().supportedTypes();
}

export class ConnectorRegistry {
  private connectors: Map<string, ObservabilityConnector> = new Map();
  private sourceConfigs: Map<string, SourceConfig> = new Map();
  private loader: PluginLoader;

  constructor(loader: PluginLoader = getPluginLoader()) {
    this.loader = loader;
  }

  async initialize(config: Config): Promise<void> {
    for (const source of config.sources) {
      this.sourceConfigs.set(source.name, source);
      if (!source.enabled) continue;
      await this.connectSource(source);
    }
  }

  private async connectSource(source: SourceConfig): Promise<void> {
    const connector = this.loader.create(source.type);
    const safeName = sanitizeForLog(source.name);
    const safeType = sanitizeForLog(source.type);
    if (!connector) {
      console.warn("Unknown connector type: %s, skipping %s", safeType, safeName);
      return;
    }
    try {
      await connector.connect(source);
      this.connectors.set(source.name, connector);
      console.log('Connector "%s" (%s) connected', safeName, safeType);
    } catch (err) {
      console.error('Failed to connect "%s":', safeName, err);
    }
  }

  async addSource(source: SourceConfig): Promise<void> {
    this.sourceConfigs.set(source.name, source);
    if (source.enabled) {
      await this.connectSource(source);
    }
  }

  async removeSource(name: string): Promise<void> {
    const connector = this.connectors.get(name);
    if (connector) {
      await connector.disconnect();
      this.connectors.delete(name);
    }
    this.sourceConfigs.delete(name);
  }

  async updateSource(name: string, source: SourceConfig): Promise<void> {
    await this.removeSource(name);
    await this.addSource(source);
  }

  async testConnection(source: SourceConfig): Promise<ConnectorHealth> {
    const connector = this.loader.create(source.type);
    if (!connector) {
      return { status: "down", latencyMs: 0, message: `Unknown type: ${source.type}` };
    }
    try {
      await connector.connect(source);
      const health = await connector.healthCheck();
      await connector.disconnect();
      return health;
    } catch (err) {
      return { status: "down", latencyMs: 0, message: String(err) };
    }
  }

  getSourceConfigs(): SourceConfig[] {
    return Array.from(this.sourceConfigs.values());
  }

  getAll(): ObservabilityConnector[] {
    return Array.from(this.connectors.values());
  }

  getByName(name: string): ObservabilityConnector | undefined {
    return this.connectors.get(name);
  }

  getBySignal(signal: SignalType): ObservabilityConnector[] {
    return this.getAll().filter((c) => c.signalType === signal);
  }

  async healthCheckAll(): Promise<Record<string, ConnectorHealth>> {
    const results: Record<string, ConnectorHealth> = {};
    for (const [name, connector] of this.connectors) {
      results[name] = await connector.healthCheck();
    }
    return results;
  }
}
