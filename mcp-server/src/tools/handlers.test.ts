import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConnectorRegistry } from "../connectors/registry.js";
import { DEFAULT_SETTINGS, DEFAULT_HEALTH_THRESHOLDS } from "../config/loader.js";
import { listSourcesHandler } from "./list-sources.js";
import { listServicesHandler } from "./list-services.js";
import { detectAnomaliesHandler } from "./detect-anomalies.js";
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

describe("detectAnomaliesHandler — A5 memory/OOM coverage", () => {
  const flatMemory = () => ({
    source: "prom1", service: "payment-service", metric: "memory", unit: "bytes",
    values: Array.from({ length: 40 }, (_, i) => ({
      timestamp: new Date(Date.now() - (40 - i) * 9000).toISOString(),
      value: 1.3e8 + (i % 3) * 1e6, // noisy, no trend → no metric anomaly
    })),
    summary: { current: 1.3e8, average: 1.3e8, min: 1.28e8, max: 1.33e8, trend: "stable" as const },
  });

  it("scans the memory metric (now in KEY_METRICS)", async () => {
    const requested: string[] = [];
    const reg = createRegistryWithMocks([
      createMockConnector({
        name: "prom1", type: "prometheus", signalType: "metrics",
        listServices: async () => [{ name: "payment-service", source: "prom1", signalType: "metrics" }],
        queryMetrics: async ({ metric }: any) => {
          requested.push(metric);
          return flatMemory();
        },
      }),
    ]);
    await detectAnomaliesHandler(reg, {});
    assert.ok(requested.includes("memory"), `memory not scanned; got ${requested.join(",")}`);
  });

  it("flags a warn-level OOM log pattern below the error-rate gate", async () => {
    const reg = createRegistryWithMocks([
      createMockConnector({
        name: "prom1", type: "prometheus", signalType: "metrics",
        listServices: async () => [{ name: "payment-service", source: "prom1", signalType: "metrics" }],
        queryMetrics: async () => flatMemory(),
      }),
      createMockConnector({
        name: "loki1", type: "loki", signalType: "logs",
        queryLogs: async () => ({
          source: "loki1", service: "payment-service", entries: [],
          // Only 4 warn-level lines: errorCount below the >5 gate, ratio tiny.
          summary: {
            total: 800, errorCount: 4, warnCount: 4,
            topPatterns: ["OutOfMemoryWarning: heap usage exceeding threshold (4x)"],
          },
        }),
      }),
    ]);
    const result = await detectAnomaliesHandler(reg, {});
    const data = JSON.parse(result.content[0].text);
    const crit = data.anomalies.find((a: any) => a.metric === "log_critical_pattern");
    assert.ok(crit, "expected a log_critical_pattern anomaly for the OOM warning");
    assert.equal(crit.service, "payment-service");
    assert.equal(crit.severity, "high");
    assert.equal(data.rootCause.ranked[0].service, "payment-service");
    assert.notEqual(data.summary, "All services healthy — no anomalies detected.");
  });

  it("does not flag benign warn patterns", async () => {
    const reg = createRegistryWithMocks([
      createMockConnector({
        name: "prom1", type: "prometheus", signalType: "metrics",
        listServices: async () => [{ name: "order-service", source: "prom1", signalType: "metrics" }],
        queryMetrics: async () => flatMemory(),
      }),
      createMockConnector({
        name: "loki1", type: "loki", signalType: "logs",
        queryLogs: async () => ({
          source: "loki1", service: "order-service", entries: [],
          summary: { total: 500, errorCount: 1, warnCount: 2, topPatterns: ["cache miss for key user:42"] },
        }),
      }),
    ]);
    const result = await detectAnomaliesHandler(reg, {});
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.anomalies.length, 0);
  });
});
