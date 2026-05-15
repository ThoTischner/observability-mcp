// Functional loader smoke: proves every connector under connectors/*
// doesn't just extract, but actually LOADS into the real server
// PluginLoader and is a wired, callable connector. Catches breakage
// that unit/contract/install tests miss — bad default export, a
// constructor that throws, a manifest/marker mismatch, a healthCheck
// that crashes instead of reporting "down", a missing capability the
// manifest advertises.
//
// Deterministic & offline: connectors point at an unreachable URL, so
// healthCheck must return a structured {status:"down"} — never throw.
//
// Run after `npm run build` in mcp-server (uses dist/).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const loaderUrl = pathToFileURL(join(ROOT, "mcp-server/dist/connectors/loader.js")).href;
const { PluginLoader } = await import(loaderUrl);

// Stage only the connector dirs into an isolated PLUGINS_DIR (so the
// loader's filesystem scan sees real plugins, nothing else).
const stage = mkdtempSync(join(tmpdir(), "loader-smoke-"));
const expected = [];
for (const name of readdirSync(join(ROOT, "connectors"))) {
  const dir = join(ROOT, "connectors", name);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    continue;
  }
  if (pkg.observabilityMcp?.kind !== "connector") continue;
  cpSync(dir, join(stage, name), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  expected.push({ name: pkg.observabilityMcp.name, manifest });
}
assert.ok(expected.length > 0, "no connectors found to smoke");

const loader = new PluginLoader({ pluginsDir: stage });
await loader.load();

let failures = 0;
for (const { name, manifest } of expected) {
  try {
    assert.ok(loader.has(name), `loader did not register '${name}'`);
    assert.ok(loader.supportedTypes().includes(name), `'${name}' missing from supportedTypes`);
    const c = loader.create(name);
    assert.ok(c, `create('${name}') returned nothing`);
    assert.equal(typeof c.connect, "function", `${name}.connect missing`);
    assert.equal(typeof c.healthCheck, "function", `${name}.healthCheck missing`);
    // Capabilities the manifest advertises must exist as methods.
    const caps = manifest.capabilities || {};
    if (caps.queryMetrics) assert.equal(typeof c.queryMetrics, "function", `${name} advertises queryMetrics but has none`);
    if (caps.queryLogs) assert.equal(typeof c.queryLogs, "function", `${name} advertises queryLogs but has none`);
    if (caps.listServices) assert.equal(typeof c.listServices, "function", `${name} advertises listServices but has none`);
    // connect to an unreachable endpoint, then healthCheck must return
    // a structured down result — not throw, not hang the server.
    await c.connect({
      name, type: name, url: "http://127.0.0.1:9", enabled: true,
      auth: { type: "basic", username: "x", password: "y", token: "x" },
    });
    const h = await Promise.race([
      c.healthCheck(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("healthCheck timed out (>10s)")), 10000)),
    ]);
    assert.ok(h && (h.status === "up" || h.status === "down"),
      `${name}.healthCheck returned ${JSON.stringify(h)}`);
    assert.equal(typeof h.latencyMs, "number", `${name}.healthCheck missing latencyMs`);
    console.log(`PASS  ${name} — loaded, wired, healthCheck → ${h.status}`);
  } catch (e) {
    failures++;
    console.error(`FAIL  ${name}: ${e instanceof Error ? e.message : e}`);
  }
}

if (failures) {
  console.error(`\n${failures} connector(s) failed the loader smoke`);
  process.exit(1);
}
console.log(`\nLOADER SMOKE OK — ${expected.length} connector(s) load & are callable in the real server`);
