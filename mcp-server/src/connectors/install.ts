// Shared connector-install core: extract a tarball, verify it
// fail-closed against a trust root (the SAME crypto as the server
// loader / omcp CLI — verify.ts), then atomically place it under
// PLUGINS_DIR. Used by the Web UI install API (and reusable by the
// CLI). Pure guards are split out for unit testing.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  loadTrustRoot,
  verifyIntegrity,
  verifyManifestSignature,
  PluginVerificationError,
} from "./verify.js";

const NAME_RE = /^[a-z][a-z0-9-]*$/;

/** A connector name is safe iff kebab-case ASCII (also blocks traversal). */
export function isValidConnectorName(name: unknown): name is string {
  return typeof name === "string" && NAME_RE.test(name);
}

/**
 * Resolve the install target and guarantee it stays directly inside
 * pluginsDir (defence-in-depth against `..`/absolute names even though
 * isValidConnectorName already rejects them).
 */
export function safeTarget(pluginsDir: string, name: string): string {
  if (!isValidConnectorName(name)) throw new Error(`invalid connector name: ${String(name)}`);
  const base = resolve(pluginsDir);
  const target = resolve(base, name);
  if (target !== join(base, name) || !target.startsWith(base + "/")) {
    throw new Error("refusing path outside PLUGINS_DIR");
  }
  return target;
}

function tarExtract(tgz: string, dest: string): void {
  const r = spawnSync("tar", ["-xzf", tgz, "-C", dest], { stdio: "pipe" });
  if (r.status !== 0) throw new Error(`tar extraction failed: ${r.stderr?.toString() || r.status}`);
}

function findPluginRoot(base: string): string | null {
  for (const dir of [base, ...readdirSync(base).map((e) => join(base, e))]) {
    try {
      if (!statSync(dir).isDirectory()) continue;
      const pkgPath = join(dir, "package.json");
      if (!existsSync(pkgPath)) continue;
      if (JSON.parse(readFileSync(pkgPath, "utf8")).observabilityMcp?.kind === "connector") return dir;
    } catch {
      /* skip */
    }
  }
  return null;
}

export interface InstallResult {
  name: string;
  version: string | null;
}

/**
 * Install a connector tarball into pluginsDir, fail-closed. Always
 * verifies the manifest signature + entry integrity against trustRoot
 * — there is intentionally NO insecure bypass on this path (it's
 * reachable over HTTP). Throws PluginVerificationError on any failure.
 */
export function installTarball(opts: {
  tgzPath: string;
  pluginsDir: string;
  trustRootPath: string;
  expectedName?: string;
}): InstallResult {
  const trustRoot = loadTrustRoot(opts.trustRootPath); // throws if unreadable/bad
  const work = mkdtempSync(join(tmpdir(), "obsmcp-install-"));
  try {
    const stage = join(work, "stage");
    mkdirSync(stage);
    tarExtract(opts.tgzPath, stage);
    const root = findPluginRoot(stage);
    if (!root) throw new PluginVerificationError("tarball has no connector package.json marker");

    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const marker = pkg.observabilityMcp;
    const name = marker?.name;
    if (!isValidConnectorName(name)) throw new PluginVerificationError(`invalid connector name in package: ${String(name)}`);
    if (opts.expectedName && opts.expectedName !== name) {
      throw new PluginVerificationError(`tarball is '${name}', expected '${opts.expectedName}'`);
    }
    const manifestRel = marker.manifest || "./manifest.json";
    const manifestPath = resolve(root, manifestRel);
    if (!existsSync(manifestPath)) throw new PluginVerificationError(`manifest not found: ${manifestRel}`);
    const sigPath = manifestPath + ".sig";
    if (!existsSync(sigPath)) throw new PluginVerificationError(`missing manifest signature: ${manifestRel}.sig`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const entryPath = resolve(root, pkg.main || "index.js");

    // Fail-closed: signature over the manifest + manifest pins the
    // entry hash. Throws PluginVerificationError on mismatch.
    verifyManifestSignature(readFileSync(manifestPath), readFileSync(sigPath), trustRoot);
    verifyIntegrity(entryPath, manifest.integrity);

    const target = safeTarget(opts.pluginsDir, name);
    mkdirSync(opts.pluginsDir, { recursive: true });
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    cpSync(root, target, { recursive: true });
    return { name, version: manifest.version ?? null };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
