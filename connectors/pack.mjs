#!/usr/bin/env node
// Pack (and optionally sign) a connector directory into the tarball the
// hub serves and `omcp plugin install` consumes.
//
//   node connectors/pack.mjs <connectorDir> --out <dir> [--key <pkcs8.pem>]
//
// Steps:
//   1. Validate manifest.integrity === sha256(entry file) — fail-closed,
//      so a stale manifest never ships.
//   2. If --key: sign the raw manifest.json bytes (ed25519) and write
//      manifest.json.sig (base64) INTO the connector dir, so it travels
//      inside the tarball (exactly what verifyPluginDir expects).
//   3. tar -czf <out>/<name>-<version>.tgz -C <connectorDir> .
//
// Dependency-free: Node crypto + system tar. No catalog mutation here —
// catalog URLs are deterministic (release tag scheme) and committed.

import { createHash, createPrivateKey, sign as edSign } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export function parsePackArgs(argv) {
  const out = { dir: undefined, outDir: "dist-connectors", key: undefined };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out.outDir = argv[++i];
    else if (argv[i] === "--key") out.key = argv[++i];
    else rest.push(argv[i]);
  }
  out.dir = rest[0];
  return out;
}

export function sha256Integrity(buf) {
  return "sha256-" + createHash("sha256").update(buf).digest("base64");
}

export function tarballName(name, version) {
  return `${name}-${version}.tgz`;
}

// Pure: derive the facts the packer needs from a connector dir's files.
export function planPack(pkgJson, manifestJson, entryBytes) {
  const marker = pkgJson.observabilityMcp;
  if (!marker || marker.kind !== "connector" || !marker.name) {
    throw new Error("package.json has no observabilityMcp connector marker");
  }
  if (manifestJson.name !== marker.name) {
    throw new Error(`manifest.name (${manifestJson.name}) != marker.name (${marker.name})`);
  }
  const actual = sha256Integrity(entryBytes);
  if (manifestJson.integrity !== actual) {
    throw new Error(`integrity stale: manifest=${manifestJson.integrity} actual=${actual}`);
  }
  return {
    name: marker.name,
    version: manifestJson.version,
    tarball: tarballName(marker.name, manifestJson.version),
  };
}

function main() {
  const { dir, outDir, key } = parsePackArgs(process.argv.slice(2));
  if (!dir) {
    console.error("usage: pack.mjs <connectorDir> --out <dir> [--key <pkcs8.pem>]");
    process.exit(1);
  }
  const root = resolve(dir);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const manifestRel = pkg.observabilityMcp?.manifest || "./manifest.json";
  const manifestPath = resolve(root, manifestRel);
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const entryPath = resolve(root, pkg.main || "index.js");
  const plan = planPack(pkg, manifest, readFileSync(entryPath));

  if (key) {
    const priv = createPrivateKey(readFileSync(key, "utf8"));
    const sig = edSign(null, manifestBytes, priv);
    writeFileSync(manifestPath + ".sig", sig.toString("base64") + "\n");
    console.log(`signed ${plan.name}: wrote manifest.json.sig`);
  } else {
    console.log(`WARNING: no --key — packing ${plan.name} UNSIGNED`);
  }

  mkdirSync(resolve(outDir), { recursive: true });
  const tgz = join(resolve(outDir), plan.tarball);
  const r = spawnSync("tar", ["-czf", tgz, "-C", root, "."], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("tar failed");
    process.exit(1);
  }
  console.log(`packed ${tgz}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
