import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConnectorRegistry } from "../connectors/registry.js";
import { queryLogsHandler } from "./query-logs.js";
import type { ObservabilityConnector } from "../connectors/interface.js";

// Inject a mock connector into the registry's internal maps.
function regWith(mock: ObservabilityConnector): ConnectorRegistry {
  const reg = new ConnectorRegistry();
  (reg as any).connectors.set(mock.name, mock);
  (reg as any).sourceConfigs.set(mock.name, { name: mock.name, type: mock.type, url: "http://mock", enabled: true });
  return reg;
}

describe("queryLogsHandler error response shape (issue #452)", () => {
  it("a failing query reports `window` (the look-back), not `duration` (read as wall-clock)", async () => {
    // Mirrors the raw_query fail-fast case: the connector throws, the handler
    // returns a structured error. The look-back window must be labelled
    // `window`, never `duration` — an agent reading duration:"5m" on a <1s
    // failure thinks it hung (the very symptom the fail-fast fix removed).
    const mock = {
      connect: async () => {}, disconnect: async () => {},
      healthCheck: async () => ({ status: "up" as const, latencyMs: 1 }),
      getDefaultMetrics: () => [], getMetrics: () => [],
      listServices: async () => [],
      name: "loki1", type: "loki", signalType: "logs" as const,
      queryLogs: async () => { throw new Error("query_logs raw_query returned a 'matrix' result, but query_logs handles log lines (streams) only."); },
    } as unknown as ObservabilityConnector;

    const result = await queryLogsHandler(
      regWith(mock),
      { raw_query: "sum(count_over_time({service_name=\"x\"} | json [1h]))", duration: "1h" },
      undefined,
      { allowRawQuery: true },
    );
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.error, "must be an error response");
    assert.equal(data.window, "1h", "look-back must be reported as `window`");
    assert.equal("duration" in data, false, "must NOT carry a `duration` field (misread as elapsed time)");
  });
});
