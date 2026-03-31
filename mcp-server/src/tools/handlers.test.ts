import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConnectorRegistry } from "../connectors/registry.js";
import { DEFAULT_SETTINGS, DEFAULT_HEALTH_THRESHOLDS } from "../config/loader.js";
import { listSourcesHandler } from "./list-sources.js";
import { listServicesHandler } from "./list-services.js";
import type { Config, ServiceInfo, MetricResult, LogResult, ConnectorHealth, MetricDefinition, SignalType } from "../types.js";
import type { ObservabilityConnector } from "../connectors/interface.js";

// --- Mock Connector ---
function createMockConnector(overrides: Partial<ObservabilityConnector> & { name: string; type: string; signalType: SignalType }): ObservabilityConnector {
  return {
    connect: async () => {},
    disconnect: async () => {},
    healthCheck: async () => ({ status: "up" as const, latencyMs: 5 }),
    getDefaultMetrics: () => [],
    getMetrics: () => [],
    listServices: async () => [],
    ...overrides,
  };
}

// Helper to inject mock connectors into registry
function createRegistryWithMocks(mocks: ObservabilityConnector[]): ConnectorRegistry {
  const reg = new ConnectorRegistry();
  // Inject directly via internal maps
  for (const mock of mocks) {
    (reg as any).connectors.set(mock.name, mock);
    (reg as any).sourceConfigs.set(mock.name, {
      name: mock.name, type: mock.type, url: "http://mock", enabled: true,
    });
  }
  return reg;
}

describe("listSourcesHandler", () => {
  it("returns empty sources for empty registry", async () => {
    const reg = new ConnectorRegistry();
    const result = await listSourcesHandler(reg);
    const data = JSON.parse(result.content[0].text);
    assert.deepEqual(data.sources, []);
  });

  it("returns sources with health status", async () => {
    const reg = createRegistryWithMocks([
      createMockConnector({
        name: "prom1", type: "prometheus", signalType: "metrics",
        healthCheck: async () => ({ status: "up", latencyMs: 12 }),
      }),
      createMockConnector({
        name: "loki1", type: "loki", signalType: "logs",
        healthCheck: async () => ({ status: "down", latencyMs: 0, message: "connection refused" }),
      }),
    ]);
    const result = await listSourcesHandler(reg);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.sources.length, 2);
    assert.equal(data.sources[0].name, "prom1");
    assert.equal(data.sources[0].status, "up");
    assert.equal(data.sources[0].latencyMs, 12);
    assert.equal(data.sources[1].name, "loki1");
    assert.equal(data.sources[1].status, "down");
  });
});

describe("listServicesHandler", () => {
  it("returns empty for no connectors", async () => {
    const reg = new ConnectorRegistry();
    const result = await listServicesHandler(reg, {});
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.total, 0);
    assert.deepEqual(data.services, []);
  });

  it("deduplicates services from multiple connectors", async () => {
    const reg = createRegistryWithMocks([
      createMockConnector({
        name: "prom1", type: "prometheus", signalType: "metrics",
        listServices: async () => [
          { name: "api-gateway", source: "prom1", signalType: "metrics" },
          { name: "payment-service", source: "prom1", signalType: "metrics" },
        ],
      }),
      createMockConnector({
        name: "loki1", type: "loki", signalType: "logs",
        listServices: async () => [
          { name: "api-gateway", source: "loki1", signalType: "logs" },
          { name: "order-service", source: "loki1", signalType: "logs" },
        ],
      }),
    ]);
    const result = await listServicesHandler(reg, {});
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.total, 3);

    const apiGw = data.services.find((s: any) => s.name === "api-gateway");
    assert.ok(apiGw);
    assert.deepEqual(apiGw.sources.sort(), ["loki1", "prom1"]);
    assert.deepEqual(apiGw.signalTypes.sort(), ["logs", "metrics"]);
  });

  it("filters services case-insensitively", async () => {
    const reg = createRegistryWithMocks([
      createMockConnector({
        name: "prom1", type: "prometheus", signalType: "metrics",
        listServices: async () => [
          { name: "API-Gateway", source: "prom1", signalType: "metrics" },
          { name: "payment-service", source: "prom1", signalType: "metrics" },
        ],
      }),
    ]);
    const result = await listServicesHandler(reg, { filter: "api" });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.total, 1);
    assert.equal(data.services[0].name, "API-Gateway");
  });

  it("handles connector errors gracefully", async () => {
    const reg = createRegistryWithMocks([
      createMockConnector({
        name: "prom1", type: "prometheus", signalType: "metrics",
        listServices: async () => { throw new Error("connection failed"); },
      }),
      createMockConnector({
        name: "loki1", type: "loki", signalType: "logs",
        listServices: async () => [
          { name: "order-service", source: "loki1", signalType: "logs" },
        ],
      }),
    ]);
    const result = await listServicesHandler(reg, {});
    const data = JSON.parse(result.content[0].text);
    // Should still return results from working connector
    assert.equal(data.total, 1);
    assert.equal(data.services[0].name, "order-service");
  });

  it("returns empty when filter matches nothing", async () => {
    const reg = createRegistryWithMocks([
      createMockConnector({
        name: "prom1", type: "prometheus", signalType: "metrics",
        listServices: async () => [
          { name: "payment-service", source: "prom1", signalType: "metrics" },
        ],
      }),
    ]);
    const result = await listServicesHandler(reg, { filter: "nonexistent" });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.total, 0);
  });
});
