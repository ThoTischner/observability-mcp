import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { substituteEnv } from "./loader.js";

// We test the helper functions by importing the module fresh with different env vars.
// Since the config path is resolved at import time, we use dynamic imports.

const TMP_DIR = join(tmpdir(), "observability-mcp-test-" + Date.now());

describe("config/loader", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
    delete process.env.CONFIG_PATH;
    delete process.env.PROMETHEUS_URL;
    delete process.env.LOKI_URL;
  });

  describe("loadConfig with CONFIG_PATH", () => {
    it("loads sources from YAML file", async () => {
      const configPath = join(TMP_DIR, "sources.yaml");
      writeFileSync(configPath, `
sources:
  - name: prom1
    type: prometheus
    url: http://localhost:9090
    enabled: true
`);
      process.env.CONFIG_PATH = configPath;
      // Dynamic import to pick up new env
      const mod = await import("./loader.js?" + Date.now());
      // loadConfig is already called at module level for CONFIG_PATH, but we call it again
      const config = mod.loadConfig();
      assert.equal(config.sources.length, 1);
      assert.equal(config.sources[0].name, "prom1");
      assert.equal(config.sources[0].url, "http://localhost:9090");
    });

    it("falls back to env vars when config file does not exist", async () => {
      process.env.CONFIG_PATH = join(TMP_DIR, "nonexistent.yaml");
      process.env.PROMETHEUS_URL = "http://p1:9090";
      process.env.LOKI_URL = "http://l1:3100";
      const mod = await import("./loader.js?" + Date.now());
      const config = mod.loadConfig();
      assert.equal(config.sources.length, 2);
      assert.equal(config.sources[0].name, "prometheus");
      assert.equal(config.sources[0].url, "http://p1:9090");
      assert.equal(config.sources[1].name, "loki");
      assert.equal(config.sources[1].url, "http://l1:3100");
    });

    it("returns empty sources when no config and no env vars", async () => {
      process.env.CONFIG_PATH = join(TMP_DIR, "nonexistent.yaml");
      const mod = await import("./loader.js?" + Date.now());
      const config = mod.loadConfig();
      assert.equal(config.sources.length, 0);
    });
  });

  describe("env var parsing - comma-separated URLs", () => {
    it("creates multiple prometheus sources from comma-separated URLs", async () => {
      process.env.CONFIG_PATH = join(TMP_DIR, "nonexistent.yaml");
      process.env.PROMETHEUS_URL = "http://p1:9090,http://p2:9090,http://p3:9090";
      const mod = await import("./loader.js?" + Date.now());
      const config = mod.loadConfig();
      assert.equal(config.sources.length, 3);
      assert.equal(config.sources[0].name, "prometheus-1");
      assert.equal(config.sources[0].url, "http://p1:9090");
      assert.equal(config.sources[1].name, "prometheus-2");
      assert.equal(config.sources[1].url, "http://p2:9090");
      assert.equal(config.sources[2].name, "prometheus-3");
      assert.equal(config.sources[2].url, "http://p3:9090");
    });

    it("uses plain name for single URL (no suffix)", async () => {
      process.env.CONFIG_PATH = join(TMP_DIR, "nonexistent.yaml");
      process.env.PROMETHEUS_URL = "http://p1:9090";
      const mod = await import("./loader.js?" + Date.now());
      const config = mod.loadConfig();
      assert.equal(config.sources.length, 1);
      assert.equal(config.sources[0].name, "prometheus");
    });

    it("trims whitespace from URLs", async () => {
      process.env.CONFIG_PATH = join(TMP_DIR, "nonexistent.yaml");
      process.env.LOKI_URL = " http://l1:3100 , http://l2:3100 ";
      const mod = await import("./loader.js?" + Date.now());
      const config = mod.loadConfig();
      assert.equal(config.sources.length, 2);
      assert.equal(config.sources[0].url, "http://l1:3100");
      assert.equal(config.sources[1].url, "http://l2:3100");
    });

    it("combines prometheus and loki sources", async () => {
      process.env.CONFIG_PATH = join(TMP_DIR, "nonexistent.yaml");
      process.env.PROMETHEUS_URL = "http://p1:9090,http://p2:9090";
      process.env.LOKI_URL = "http://l1:3100";
      const mod = await import("./loader.js?" + Date.now());
      const config = mod.loadConfig();
      assert.equal(config.sources.length, 3);
      assert.equal(config.sources[0].name, "prometheus-1");
      assert.equal(config.sources[1].name, "prometheus-2");
      assert.equal(config.sources[2].name, "loki");
    });
  });

  describe("saveConfig", () => {
    it("creates directory and writes YAML file", async () => {
      const configPath = join(TMP_DIR, "sub", "dir", "sources.yaml");
      process.env.CONFIG_PATH = configPath;
      const mod = await import("./loader.js?" + Date.now());
      const config = mod.loadConfig();
      config.sources.push({ name: "test", type: "prometheus", url: "http://test:9090", enabled: true });
      mod.saveConfig(config);
      assert.ok(existsSync(configPath));
      // Re-load and verify
      const reloaded = mod.loadConfig();
      assert.equal(reloaded.sources.length, 1);
      assert.equal(reloaded.sources[0].name, "test");
    });
  });

  describe("default settings", () => {
    it("has correct defaults", async () => {
      process.env.CONFIG_PATH = join(TMP_DIR, "nonexistent.yaml");
      const mod = await import("./loader.js?" + Date.now());
      const config = mod.loadConfig();
      assert.equal(config.settings.checkIntervalMs, 30000);
      assert.equal(config.settings.defaultSensitivity, "medium");
    });

    it("has correct default health thresholds", async () => {
      process.env.CONFIG_PATH = join(TMP_DIR, "nonexistent.yaml");
      const mod = await import("./loader.js?" + Date.now());
      const config = mod.loadConfig();
      assert.equal(config.healthThresholds.weights.errorRate, 0.35);
      assert.equal(config.healthThresholds.cpu.crit, 95);
      assert.equal(config.healthThresholds.statusBoundaries.healthy, 80);
    });
  });

  describe("substituteEnv", () => {
    it("replaces ${VAR} with process.env value", () => {
      process.env.TEST_FOO = "bar";
      assert.equal(substituteEnv('value: "${TEST_FOO}"'), 'value: "bar"');
      delete process.env.TEST_FOO;
    });

    it("uses default with ${VAR:-default} when unset", () => {
      delete process.env.TEST_UNSET;
      assert.equal(substituteEnv('value: "${TEST_UNSET:-fallback}"'), 'value: "fallback"');
    });

    it("prefers env value over default", () => {
      process.env.TEST_SET = "real";
      assert.equal(substituteEnv('value: "${TEST_SET:-fallback}"'), 'value: "real"');
      delete process.env.TEST_SET;
    });

    it("returns empty string for undefined var without default", () => {
      delete process.env.TEST_MISSING;
      const origWarn = console.warn;
      console.warn = () => {};
      try {
        assert.equal(substituteEnv('value: "${TEST_MISSING}"'), 'value: ""');
      } finally {
        console.warn = origWarn;
      }
    });

    it("leaves yaml without placeholders unchanged", () => {
      const yaml = "sources:\n  - name: prom\n    url: http://localhost:9090\n";
      assert.equal(substituteEnv(yaml), yaml);
    });

    it("handles multiple substitutions in one string", () => {
      process.env.A = "1";
      process.env.B = "2";
      assert.equal(substituteEnv("${A}-${B}-${C:-3}"), "1-2-3");
      delete process.env.A;
      delete process.env.B;
    });

    it("substitutes inside loaded YAML config", async () => {
      process.env.GRAFANA_USER = "12345";
      process.env.GRAFANA_TOKEN = "secret-token";
      const configPath = join(TMP_DIR, "envsubst.yaml");
      writeFileSync(configPath, `
sources:
  - name: grafana
    type: prometheus
    url: https://grafana.example.com
    enabled: true
    auth:
      type: basic
      username: "\${GRAFANA_USER}"
      password: "\${GRAFANA_TOKEN}"
`);
      process.env.CONFIG_PATH = configPath;
      const mod = await import("./loader.js?" + Date.now());
      const config = mod.loadConfig();
      assert.equal(config.sources[0].auth?.username, "12345");
      assert.equal(config.sources[0].auth?.password, "secret-token");
      delete process.env.GRAFANA_USER;
      delete process.env.GRAFANA_TOKEN;
    });
  });

  describe("config merging", () => {
    it("merges partial settings with defaults", async () => {
      const configPath = join(TMP_DIR, "partial.yaml");
      writeFileSync(configPath, `
sources: []
settings:
  checkIntervalMs: 60000
`);
      process.env.CONFIG_PATH = configPath;
      const mod = await import("./loader.js?" + Date.now());
      const config = mod.loadConfig();
      assert.equal(config.settings.checkIntervalMs, 60000);
      assert.equal(config.settings.defaultSensitivity, "medium"); // default preserved
    });

    it("deep-merges health thresholds", async () => {
      const configPath = join(TMP_DIR, "thresholds.yaml");
      writeFileSync(configPath, `
sources: []
healthThresholds:
  cpu:
    crit: 99
`);
      process.env.CONFIG_PATH = configPath;
      const mod = await import("./loader.js?" + Date.now());
      const config = mod.loadConfig();
      assert.equal(config.healthThresholds.cpu.crit, 99);    // overridden
      assert.equal(config.healthThresholds.cpu.good, 50);     // default preserved
      assert.equal(config.healthThresholds.cpu.warn, 80);     // default preserved
      assert.equal(config.healthThresholds.weights.errorRate, 0.35); // other sections preserved
    });
  });
});
