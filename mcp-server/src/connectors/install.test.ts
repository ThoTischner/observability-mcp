import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { isValidConnectorName, safeTarget, installTarball } from "./install.js";
import { PluginVerificationError } from "./verify.js";

test("isValidConnectorName: kebab only, blocks traversal", () => {
  assert.ok(isValidConnectorName("datadog"));
  assert.ok(isValidConnectorName("my-connector9"));
  for (const bad of ["../evil", "Foo", "a/b", "", "1abc", "a_b", null, 42]) {
    assert.equal(isValidConnectorName(bad as unknown), false);
  }
});

test("safeTarget keeps the path inside pluginsDir", () => {
  const t = safeTarget("/plugins", "datadog");
  assert.equal(t, "/plugins/datadog");
  assert.throws(() => safeTarget("/plugins", "../etc"), /invalid connector name|outside/);
});

function mkSignedTarball(dir: string, name: string, priv: import("node:crypto").KeyObject, opts: { tamper?: boolean; noSig?: boolean } = {}) {
  const src = join(dir, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "index.js"), "export default () => ({});\n");
  const integ =
    "sha256-" + createHash("sha256").update(readFileSync(join(src, "index.js"))).digest("base64");
  const manifest = { schemaVersion: 1, name, displayName: name, version: "1.0.0", description: "x", signalTypes: ["metrics"], integrity: integ };
  const mb = Buffer.from(JSON.stringify(manifest));
  writeFileSync(join(src, "manifest.json"), mb);
  if (!opts.noSig) writeFileSync(join(src, "manifest.json.sig"), edSign(null, mb, priv));
  writeFileSync(join(src, "package.json"), JSON.stringify({ name, main: "index.js", observabilityMcp: { kind: "connector", name, manifest: "./manifest.json" } }));
  if (opts.tamper) writeFileSync(join(src, "index.js"), "export default () => ({}); /* tampered */\n");
  const tgz = join(dir, `${name}-1.0.0.tgz`);
  const r = spawnSync("tar", ["-czf", tgz, "-C", src, "."]);
  assert.equal(r.status, 0, "tar failed in test setup");
  return tgz;
}

test("installTarball: verifies + installs; rejects tamper / missing sig / wrong name", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const work = mkdtempSync(join(tmpdir(), "it-"));
  const pub = join(work, "pub.pem");
  writeFileSync(pub, publicKey.export({ type: "spki", format: "pem" }) as string);
  const pluginsDir = join(work, "plugins");

  const good = mkSignedTarball(join(work, "good"), "datadog", privateKey);
  const r = installTarball({ tgzPath: good, pluginsDir, trustRootPath: pub });
  assert.equal(r.name, "datadog");
  assert.equal(r.version, "1.0.0");
  assert.ok(existsSync(join(pluginsDir, "datadog", "manifest.json")));

  const tampered = mkSignedTarball(join(work, "bad"), "datadog", privateKey, { tamper: true });
  assert.throws(() => installTarball({ tgzPath: tampered, pluginsDir, trustRootPath: pub }), PluginVerificationError);

  const noSig = mkSignedTarball(join(work, "nosig"), "datadog", privateKey, { noSig: true });
  assert.throws(() => installTarball({ tgzPath: noSig, pluginsDir, trustRootPath: pub }), /missing manifest signature/);

  const other = mkSignedTarball(join(work, "other"), "grafana", privateKey);
  assert.throws(
    () => installTarball({ tgzPath: other, pluginsDir, trustRootPath: pub, expectedName: "datadog" }),
    /expected 'datadog'/
  );
});
