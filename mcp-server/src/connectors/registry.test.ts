import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getSupportedTypes, ConnectorRegistry } from "./registry.js";
import type { Config } from "../types.js";
import { DEFAULT_SETTINGS, DEFAULT_HEALTH_THRESHOLDS } from "../config/loader.js";

function makeConfig(sources: Config["sources"] = []): Config {
  return { sources, settings: DEFAULT_SETTINGS, healthThresholds: DEFAULT_HEALTH_THRESHOLDS };
}

describe("getSupportedTypes", () => {
  it("returns prometheus and loki", () => {
    const types = getSupportedTypes();
    assert.ok(types.includes("prometheus"));
    assert.ok(types.includes("loki"));
    assert.equal(types.length, 2);
  });
});

describe("ConnectorRegistry", () => {
  describe("initialize", () => {
    it("stores source configs even when disabled", async () => {
      const reg = new ConnectorRegistry();
      await reg.initialize(makeConfig([
        { name: "prom1", type: "prometheus", url: "http://invalid:9090", enabled: false },
      ]));
      const configs = reg.getSourceConfigs();
      assert.equal(configs.length, 1);
      assert.equal(configs[0].name, "prom1");
      // Not connected since disabled
      assert.equal(reg.getAll().length, 0);
    });

    it("skips unknown connector types gracefully", async () => {
      const reg = new ConnectorRegistry();
      await reg.initialize(makeConfig([
        { name: "unknown1", type: "influxdb", url: "http://localhost:8086", enabled: true },
      ]));
      assert.equal(reg.getSourceConfigs().length, 1);
      assert.equal(reg.getAll().length, 0); // not connected
    });

    it("handles empty sources", async () => {
      const reg = new ConnectorRegistry();
      await reg.initialize(makeConfig([]));
      assert.equal(reg.getSourceConfigs().length, 0);
      assert.equal(reg.getAll().length, 0);
    });
  });

  describe("getByName", () => {
    it("returns undefined for non-existent source", () => {
      const reg = new ConnectorRegistry();
      assert.equal(reg.getByName("nonexistent"), undefined);
    });
  });

  describe("getBySignal", () => {
    it("returns empty array when no connectors", () => {
      const reg = new ConnectorRegistry();
      assert.deepEqual(reg.getBySignal("metrics"), []);
      assert.deepEqual(reg.getBySignal("logs"), []);
    });
  });

  describe("addSource and removeSource", () => {
    it("adds disabled source without connecting", async () => {
      const reg = new ConnectorRegistry();
      await reg.addSource({ name: "prom-disabled", type: "prometheus", url: "http://invalid:9090", enabled: false });
      assert.equal(reg.getSourceConfigs().length, 1);
      assert.equal(reg.getAll().length, 0);
    });

    it("removes source config and connector", async () => {
      const reg = new ConnectorRegistry();
      await reg.addSource({ name: "test-src", type: "prometheus", url: "http://invalid:9090", enabled: false });
      assert.equal(reg.getSourceConfigs().length, 1);
      await reg.removeSource("test-src");
      assert.equal(reg.getSourceConfigs().length, 0);
    });

    it("removeSource is safe for non-existent name", async () => {
      const reg = new ConnectorRegistry();
      await reg.removeSource("does-not-exist"); // should not throw
    });
  });

  describe("testConnection", () => {
    it("returns error for unknown connector type", async () => {
      const reg = new ConnectorRegistry();
      const result = await reg.testConnection({
        name: "test", type: "unknown_type", url: "http://localhost", enabled: true,
      });
      assert.equal(result.status, "down");
      assert.ok(result.message?.includes("Unknown type"));
    });
  });

  describe("healthCheckAll", () => {
    it("returns empty object when no connectors", async () => {
      const reg = new ConnectorRegistry();
      const results = await reg.healthCheckAll();
      assert.deepEqual(results, {});
    });
  });
});
