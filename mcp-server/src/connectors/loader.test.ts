import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginLoader } from "./loader.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "loader-default-"));
}

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("PluginLoader: VERIFY_PLUGINS defaults to ON when env var unset", () => {
  withEnv({ VERIFY_PLUGINS: undefined, PLUGIN_TRUST_ROOT: undefined }, () => {
    const loader = new PluginLoader({ pluginsDir: tmp() });
    assert.equal(loader["verify"], true, "verify default should be true (fail-closed)");
  });
});

test("PluginLoader: VERIFY_PLUGINS=false opts out explicitly", () => {
  withEnv({ VERIFY_PLUGINS: "false" }, () => {
    const loader = new PluginLoader({ pluginsDir: tmp() });
    assert.equal(loader["verify"], false);
  });
});

test("PluginLoader: VERIFY_PLUGINS=0 / no / off also opt out", () => {
  for (const v of ["0", "no", "off", "FALSE", "Off"]) {
    withEnv({ VERIFY_PLUGINS: v }, () => {
      const loader = new PluginLoader({ pluginsDir: tmp() });
      assert.equal(loader["verify"], false, `value ${v} should disable verify`);
    });
  }
});

test("PluginLoader: VERIFY_PLUGINS=true / 1 / yes keep verify on", () => {
  for (const v of ["true", "1", "yes", "TRUE", "Yes"]) {
    withEnv({ VERIFY_PLUGINS: v }, () => {
      const loader = new PluginLoader({ pluginsDir: tmp() });
      assert.equal(loader["verify"], true);
    });
  }
});

test("PluginLoader: opts.verify overrides env var", () => {
  withEnv({ VERIFY_PLUGINS: "false" }, () => {
    const onLoader = new PluginLoader({ pluginsDir: tmp(), verify: true });
    assert.equal(onLoader["verify"], true);
  });
  withEnv({ VERIFY_PLUGINS: "true" }, () => {
    const offLoader = new PluginLoader({ pluginsDir: tmp(), verify: false });
    assert.equal(offLoader["verify"], false);
  });
});

test("PluginLoader.load(): with verify on + no trust root → builtins still load, filesystem skipped", async () => {
  withEnv({ VERIFY_PLUGINS: undefined, PLUGIN_TRUST_ROOT: undefined }, async () => {
    const loader = new PluginLoader({ pluginsDir: tmp() });
    await loader.load();
    const names = loader.supportedTypes();
    assert.ok(names.includes("prometheus"), "prometheus builtin must remain available");
    assert.ok(names.includes("loki"), "loki builtin must remain available");
    assert.ok(names.includes("kubernetes"), "kubernetes builtin must remain available");
  });
});
