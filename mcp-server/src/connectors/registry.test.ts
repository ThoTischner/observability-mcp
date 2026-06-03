import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getSupportedTypes, ConnectorRegistry } from "./registry.js";
import type { Config } from "../types.js";
import { DEFAULT_SETTINGS, DEFAULT_HEALTH_THRESHOLDS } from "../config/loader.js";
import { getPluginLoader } from "./loader.js";

function makeConfig(sources: Config["sources"] = []): Config {
  return { sources, settings: DEFAULT_SETTINGS, healthThresholds: DEFAULT_HEALTH_THRESHOLDS };
}

describe("getSupportedTypes", () => {
  it("returns the builtins (prometheus, loki, kubernetes) after loader.load()", async () => {
    // The PluginLoader registers builtins inside load(), not the
    // constructor — at server boot index.ts awaits load() before any
    // tool registration code runs. Mirror that here so the test
    // reflects the real wiring rather than a transient empty state.
    await getPluginLoader().load();
    const types = getSupportedTypes();
    assert.ok(types.includes("prometheus"));
    assert.ok(types.includes("loki"));
    assert.ok(types.includes("kubernetes"));
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

  describe("getByTenant / getByNameForTenant", () => {
    it("untagged sources are visible to every tenant (pre-E7 single-tenant default)", async () => {
      await getPluginLoader().load();
      const reg = new ConnectorRegistry();
      await reg.initialize(makeConfig([
        // No tenant on either source — both are "global".
        { name: "prom-global", type: "prometheus", url: "http://p:9090", enabled: true },
        { name: "loki-global", type: "loki", url: "http://l:3100", enabled: true },
      ]));
      const acmeVisible = reg.getByTenant("acme").map((c) => c.name).sort();
      const bigcoVisible = reg.getByTenant("bigco").map((c) => c.name).sort();
      assert.deepEqual(acmeVisible, ["loki-global", "prom-global"]);
      assert.deepEqual(bigcoVisible, ["loki-global", "prom-global"]);
    });

    it("tenant-tagged source is invisible to other tenants", async () => {
      await getPluginLoader().load();
      const reg = new ConnectorRegistry();
      await reg.initialize(makeConfig([
        { name: "shared", type: "prometheus", url: "http://p:9090", enabled: true },
        { name: "acme-only", type: "loki", url: "http://l:3100", enabled: true, tenant: "acme" },
      ]));
      assert.deepEqual(reg.getByTenant("acme").map((c) => c.name).sort(), ["acme-only", "shared"]);
      // bigco sees only the shared source — the acme-only one is hidden.
      assert.deepEqual(reg.getByTenant("bigco").map((c) => c.name).sort(), ["shared"]);
    });

    it("getByNameForTenant returns undefined on cross-tenant probe (no existence leak)", async () => {
      await getPluginLoader().load();
      const reg = new ConnectorRegistry();
      await reg.initialize(makeConfig([
        { name: "acme-loki", type: "loki", url: "http://l:3100", enabled: true, tenant: "acme" },
      ]));
      // Within tenant: resolves.
      assert.ok(reg.getByNameForTenant("acme-loki", "acme"));
      // Cross-tenant: undefined — indistinguishable from "no such source".
      assert.equal(reg.getByNameForTenant("acme-loki", "bigco"), undefined);
      // Unknown name in own tenant: also undefined.
      assert.equal(reg.getByNameForTenant("nope", "acme"), undefined);
    });

    it("a source whose tenant is unset resolves for every tenant via getByNameForTenant", async () => {
      await getPluginLoader().load();
      const reg = new ConnectorRegistry();
      await reg.initialize(makeConfig([
        { name: "global", type: "prometheus", url: "http://p:9090", enabled: true },
      ]));
      assert.ok(reg.getByNameForTenant("global", "acme"));
      assert.ok(reg.getByNameForTenant("global", "bigco"));
    });
  });
});
