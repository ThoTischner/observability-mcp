import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import { PluginLoader } from "./loader.js";
import { PluginVerificationError, sha256Integrity } from "./verify.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "loader-default-"));
}

const ENTRY_SRC = "export default () => ({});\n";

/** Write a public-key PEM trust root + return its path and the signing key. */
function makeTrustRoot(): { path: string; privateKey: import("node:crypto").KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const dir = mkdtempSync(join(tmpdir(), "loader-trust-"));
  const p = join(dir, "trust.pem");
  writeFileSync(p, publicKey.export({ type: "spki", format: "pem" }) as string);
  return { path: p, privateKey };
}

/** Build a filesystem connector plugin dir under `pluginsDir`.
 *  opts.manifest=false → no manifest.json; opts.sign omitted → no .sig;
 *  opts.sign=key → a valid detached signature over the manifest bytes. */
function makePlugin(
  pluginsDir: string,
  name: string,
  opts: {
    manifest?: boolean;
    sign?: import("node:crypto").KeyObject;
    /** Write this raw string AS the manifest (e.g. "{ not json" or a name
     *  mismatch) instead of the structured one — for malformed-manifest tests. */
    rawManifest?: string;
    /** Override the integrity field to force a verifyIntegrity mismatch. */
    integrity?: string;
  } = {},
): void {
  const root = join(pluginsDir, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "index.js"), ENTRY_SRC);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ main: "index.js", observabilityMcp: { kind: "connector", name, manifest: "manifest.json" } }),
  );
  if (opts.manifest === false) return;
  const manifestPath = join(root, "manifest.json");
  const manifestBytes =
    opts.rawManifest !== undefined
      ? Buffer.from(opts.rawManifest)
      : Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            name,
            displayName: name,
            version: "1.0.0",
            description: `${name} test connector`,
            signalTypes: ["metrics"],
            integrity: opts.integrity ?? sha256Integrity(Buffer.from(ENTRY_SRC)),
          }),
        );
  writeFileSync(manifestPath, manifestBytes);
  if (opts.sign) writeFileSync(manifestPath + ".sig", cryptoSign(null, manifestBytes, opts.sign));
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

test("PluginLoader.load(): builtins carry manifest metadata (description shows in Installed Connectors)", async () => {
  const loader = new PluginLoader({ pluginsDir: tmp() });
  await loader.load();
  for (const name of ["prometheus", "loki", "kubernetes"]) {
    const c = loader.get(name);
    assert.ok(c, `${name} builtin present`);
    assert.ok(c!.manifest, `${name} builtin has a manifest`);
    assert.ok((c!.manifest!.description || "").length > 10, `${name} builtin has a non-empty description`);
    assert.equal(c!.manifest!.name, name);
  }
});

// --- PLUGIN_REQUIRE_SIGNATURE (strict load-time enforcement) ---

test("PluginLoader: PLUGIN_REQUIRE_SIGNATURE=true sets requireSignature and forces verify on", () => {
  for (const v of ["true", "1", "yes", "On"]) {
    // Even with VERIFY_PLUGINS=false, requiring signatures implies verifying.
    withEnv({ PLUGIN_REQUIRE_SIGNATURE: v, VERIFY_PLUGINS: "false" }, () => {
      const loader = new PluginLoader({ pluginsDir: tmp() });
      assert.equal(loader["requireSignature"], true, `value ${v} should enable strict mode`);
      assert.equal(loader["verify"], true, "requireSignature implies verify");
    });
  }
  withEnv({ PLUGIN_REQUIRE_SIGNATURE: undefined }, () => {
    assert.equal(new PluginLoader({ pluginsDir: tmp() })["requireSignature"], false, "default OFF");
  });
});

test("strict mode: a plugin with no manifest ABORTS load() (hard fail, not skip)", async () => {
  const dir = tmp();
  makePlugin(dir, "unsigned-conn", { manifest: false });
  const trust = makeTrustRoot();
  const loader = new PluginLoader({ pluginsDir: dir, verify: true, trustRoot: trust.path, requireSignature: true });
  await assert.rejects(() => loader.load(), PluginVerificationError);
});

test("strict mode: a plugin with manifest but missing .sig ABORTS load()", async () => {
  const dir = tmp();
  makePlugin(dir, "nosig-conn", { /* manifest yes, sign no */ });
  const trust = makeTrustRoot();
  const loader = new PluginLoader({ pluginsDir: dir, verify: true, trustRoot: trust.path, requireSignature: true });
  await assert.rejects(() => loader.load(), PluginVerificationError);
});

test("strict mode: missing trust root ABORTS load() (misconfiguration)", async () => {
  const loader = new PluginLoader({ pluginsDir: tmp(), verify: true, trustRoot: undefined, requireSignature: true });
  await assert.rejects(() => loader.load(), /PLUGIN_TRUST_ROOT is unset/);
});

test("NON-strict (default): the same unverifiable plugin is skipped, builtins still load", async () => {
  const dir = tmp();
  makePlugin(dir, "unsigned-conn", { manifest: false });
  const trust = makeTrustRoot();
  const loader = new PluginLoader({ pluginsDir: dir, verify: true, trustRoot: trust.path /* requireSignature default false */ });
  await loader.load(); // must NOT throw
  const names = loader.supportedTypes();
  assert.ok(names.includes("prometheus"), "builtins still load");
  assert.ok(!names.includes("unsigned-conn"), "unverifiable plugin skipped, not registered");
});

test("strict mode: a correctly-signed plugin loads without error", async () => {
  const dir = tmp();
  const trust = makeTrustRoot();
  makePlugin(dir, "good-conn", { sign: trust.privateKey });
  const loader = new PluginLoader({ pluginsDir: dir, verify: true, trustRoot: trust.path, requireSignature: true });
  await loader.load(); // valid signature + integrity → no throw
  assert.ok(loader.supportedTypes().includes("good-conn"), "signed plugin registered under strict mode");
});

// A present-but-malformed manifest is "present but cannot be verified" — strict
// mode must hard-fail, not silently drop the connector.
test("strict mode: unparseable manifest.json ABORTS load()", async () => {
  const dir = tmp();
  makePlugin(dir, "corrupt-conn", { rawManifest: "{ this is not valid json" });
  const trust = makeTrustRoot();
  const loader = new PluginLoader({ pluginsDir: dir, verify: true, trustRoot: trust.path, requireSignature: true });
  await assert.rejects(() => loader.load(), PluginVerificationError);
});

test("strict mode: schema-invalid manifest.json ABORTS load()", async () => {
  const dir = tmp();
  // Missing required fields (displayName/version/signalTypes/...).
  makePlugin(dir, "badschema-conn", { rawManifest: JSON.stringify({ schemaVersion: 1, name: "badschema-conn" }) });
  const trust = makeTrustRoot();
  const loader = new PluginLoader({ pluginsDir: dir, verify: true, trustRoot: trust.path, requireSignature: true });
  await assert.rejects(() => loader.load(), PluginVerificationError);
});

test("strict mode: integrity mismatch ABORTS load() (signed manifest, wrong digest)", async () => {
  const dir = tmp();
  const trust = makeTrustRoot();
  // Validly signed manifest, but its integrity does not match index.js.
  makePlugin(dir, "tampered-conn", { sign: trust.privateKey, integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
  const loader = new PluginLoader({ pluginsDir: dir, verify: true, trustRoot: trust.path, requireSignature: true });
  await assert.rejects(() => loader.load(), PluginVerificationError);
});

test("NON-strict: a malformed manifest is still skipped (not fatal), builtins load", async () => {
  const dir = tmp();
  makePlugin(dir, "corrupt-conn", { rawManifest: "{ nope" });
  const trust = makeTrustRoot();
  const loader = new PluginLoader({ pluginsDir: dir, verify: true, trustRoot: trust.path /* non-strict */ });
  await loader.load(); // must NOT throw
  assert.ok(loader.supportedTypes().includes("prometheus"), "builtins still load");
  assert.ok(!loader.supportedTypes().includes("corrupt-conn"), "malformed plugin skipped");
});
