// Manifest-driven hook auto-registration (Q10).
//
// Stages a synthetic plugin directory with:
//   - package.json + manifest.json declaring hooks[]
//   - index.js exporting a no-op connector factory
//   - hooks/<kind>.js modules exporting handler defaults
// Runs PluginLoader (with VERIFY_PLUGINS off — we test the
// hook wiring, not the trust-root path) and asserts the
// HookRegistry now has the entries the manifest declared.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginLoader } from "./loader.js";
import { HookRegistry } from "../sdk/hooks.js";

interface HookSpec {
  kind: string;
  module: string;
  priority?: number;
  mode?: string;
  body?: string;
}

function stagePlugin(opts: {
  name: string;
  hooks?: HookSpec[];
  indexJs?: string;
}): string {
  const stage = mkdtempSync(join(tmpdir(), "omcp-plugin-hooks-"));
  const root = join(stage, opts.name);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: `@observability-mcp/connector-${opts.name}`,
      observabilityMcp: { kind: "connector", name: opts.name, manifest: "./manifest.json" },
      main: "./index.js",
    }),
  );
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: opts.name,
      displayName: opts.name,
      version: "1.0.0",
      description: "test plugin",
      signalTypes: ["topology"],
      capabilities: { listServices: true },
      compat: { serverVersion: ">=3.0.0" },
      hooks: opts.hooks?.map((h) => ({
        kind: h.kind,
        module: h.module,
        priority: h.priority,
        mode: h.mode,
      })),
    }),
  );
  // Tiny no-op connector factory.
  writeFileSync(
    join(root, "index.js"),
    opts.indexJs ??
      `export default function create() {
        return {
          type: "${opts.name}",
          signalType: "topology",
          name: "${opts.name}",
          async connect() {},
          async healthCheck() { return { status: "down", latencyMs: 0 }; },
          async disconnect() {},
          getDefaultMetrics() { return []; },
          getMetrics() { return []; },
          async listServices() { return []; },
        };
      }`,
  );
  // Hook modules — each writes a marker into the global for assertions.
  for (const h of opts.hooks ?? []) {
    const hookPath = join(root, h.module);
    mkdirSync(join(hookPath, ".."), { recursive: true });
    writeFileSync(
      hookPath,
      h.body ??
        `export default async function handler(ctx, payload) {
          globalThis.__omcp_test_hook_calls = (globalThis.__omcp_test_hook_calls ?? []);
          globalThis.__omcp_test_hook_calls.push({ plugin: ctx.principal, kind: ctx.kind, target: ctx.target });
          return { allow: true, payload };
        }`,
    );
  }
  return stage;
}

test("PluginLoader: manifest hooks auto-register on plugin load", async () => {
  const stage = stagePlugin({
    name: "alpha",
    hooks: [
      { kind: "tool_pre_invoke", module: "hooks/pre.mjs", priority: 50 },
      { kind: "tool_post_invoke", module: "hooks/post.mjs" },
    ],
  });
  const registry = new HookRegistry();
  const loader = new PluginLoader({
    pluginsDir: stage,
    verify: false,
    hookRegistry: registry,
  });
  await loader.load();

  const pre = registry.list("tool_pre_invoke");
  const post = registry.list("tool_post_invoke");
  assert.equal(pre.length, 1);
  assert.equal(pre[0].pluginName, "alpha");
  assert.equal(pre[0].priority, 50);
  assert.equal(post.length, 1);
  assert.equal(post[0].pluginName, "alpha");
  assert.equal(post[0].priority, 100); // default
});

test("PluginLoader: hook handlers fire end-to-end through HookRegistry", async () => {
  delete (globalThis as Record<string, unknown>).__omcp_test_hook_calls;
  const stage = stagePlugin({
    name: "beta",
    hooks: [{ kind: "tool_pre_invoke", module: "hooks/pre.mjs" }],
  });
  const registry = new HookRegistry();
  const loader = new PluginLoader({ pluginsDir: stage, verify: false, hookRegistry: registry });
  await loader.load();

  const result = await registry.fire(
    "tool_pre_invoke",
    { principal: "alice", tenant: "default", kind: "tool_pre_invoke", target: "tool.x" },
    { args: { foo: 1 } },
  );
  assert.equal(result.allow, true);
  const calls = (globalThis as { __omcp_test_hook_calls?: Array<unknown> }).__omcp_test_hook_calls;
  assert.ok(calls && calls.length === 1, "hook should have fired once");
});

test("PluginLoader: missing hook module is skipped with a warning, others still register", async () => {
  // Stage one good hook normally, then rewrite the manifest to ALSO
  // reference a sibling module path that doesn't exist on disk. The
  // loader must skip the missing one (existsSync branch) and still
  // register the good one.
  const stage = stagePlugin({
    name: "gamma",
    hooks: [{ kind: "tool_post_invoke", module: "hooks/post.mjs" }],
  });
  const manifestPath = join(stage, "gamma", "manifest.json");
  const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  raw.hooks = [
    { kind: "tool_pre_invoke", module: "hooks/genuinely-missing.mjs" },
    { kind: "tool_post_invoke", module: "hooks/post.mjs" },
  ];
  writeFileSync(manifestPath, JSON.stringify(raw));

  const registry = new HookRegistry();
  await new PluginLoader({ pluginsDir: stage, verify: false, hookRegistry: registry }).load();
  // The missing pre hook was skipped; the good post hook registered.
  assert.equal(registry.list("tool_pre_invoke").length, 0);
  assert.equal(registry.list("tool_post_invoke").length, 1);
});

test("PluginLoader: hook module path that escapes the plugin root is rejected", async () => {
  // Stage a plugin whose manifest tries to reference a path with `..`
  // — the loader must refuse to import it.
  const stage = mkdtempSync(join(tmpdir(), "omcp-plugin-escape-"));
  const root = join(stage, "evil");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "@observability-mcp/connector-evil",
      observabilityMcp: { kind: "connector", name: "evil", manifest: "./manifest.json" },
      main: "./index.js",
    }),
  );
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "evil",
      displayName: "evil",
      version: "1.0.0",
      description: "x",
      signalTypes: ["topology"],
      capabilities: { listServices: true },
      hooks: [{ kind: "tool_pre_invoke", module: "../escape.mjs" }],
    }),
  );
  writeFileSync(
    join(root, "index.js"),
    `export default function create() {
      return {
        type: "evil", signalType: "topology", name: "evil",
        async connect() {},
        async healthCheck() { return { status: "down", latencyMs: 0 }; },
        async disconnect() {},
        getDefaultMetrics() { return []; },
        getMetrics() { return []; },
        async listServices() { return []; },
      };
    }`,
  );
  // Stage a file outside the plugin root the manifest references.
  writeFileSync(
    join(stage, "escape.mjs"),
    `export default async () => ({ allow: false, reason: "should never run" });`,
  );
  const registry = new HookRegistry();
  const loader = new PluginLoader({ pluginsDir: stage, verify: false, hookRegistry: registry });
  await loader.load();
  // The escape hook was refused; nothing in the registry.
  assert.equal(registry.list("tool_pre_invoke").length, 0);
});

test("PluginLoader: hot-reload — re-loading replaces prior hook registrations", async () => {
  const stage = stagePlugin({
    name: "delta",
    hooks: [{ kind: "tool_pre_invoke", module: "hooks/pre.mjs", priority: 10 }],
  });
  const registry = new HookRegistry();
  await new PluginLoader({ pluginsDir: stage, verify: false, hookRegistry: registry }).load();
  assert.equal(registry.list("tool_pre_invoke").length, 1);

  // Re-load (same stage, same plugin) — registry should still hold
  // exactly one entry for tool_pre_invoke owned by delta. The loader
  // calls unregisterPlugin first, then re-registers.
  await new PluginLoader({ pluginsDir: stage, verify: false, hookRegistry: registry }).load();
  const after = registry.list("tool_pre_invoke");
  assert.equal(after.length, 1);
  assert.equal(after[0].pluginName, "delta");
});

test("PluginLoader: no hookRegistry passed → hooks are silently ignored (back-compat)", async () => {
  const stage = stagePlugin({
    name: "epsilon",
    hooks: [{ kind: "tool_pre_invoke", module: "hooks/pre.mjs" }],
  });
  // No hookRegistry — load() must not throw.
  const loader = new PluginLoader({ pluginsDir: stage, verify: false });
  await loader.load();
  assert.ok(loader.has("epsilon"));
});

test("PluginLoader: hook with no default export is skipped", async () => {
  const stage = stagePlugin({
    name: "zeta",
    hooks: [{ kind: "tool_pre_invoke", module: "hooks/noexport.mjs" }],
  });
  // Overwrite the noexport.mjs file to remove default export.
  writeFileSync(
    join(stage, "zeta", "hooks", "noexport.mjs"),
    "export const meta = 'no handler here';",
  );
  const registry = new HookRegistry();
  await new PluginLoader({ pluginsDir: stage, verify: false, hookRegistry: registry }).load();
  assert.equal(registry.list("tool_pre_invoke").length, 0);
});
