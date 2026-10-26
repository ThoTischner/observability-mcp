// End-to-end test for the SDK's create-connector CLI. Runs the real bin in a
// temp dir and checks the skeleton it writes. By default it runs the TS
// source through mcp-server's tsx (the PR security scan has that installed);
// sdk-publish sets SDK_CLI to the built dist/ bin it is about to ship.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK_PKG = JSON.parse(await readFile(join(ROOT, "packages/sdk/package.json"), "utf8"));

function runCli(cwd, ...args) {
  const cli = process.env.SDK_CLI
    ? [resolve(ROOT, process.env.SDK_CLI)]
    : [join(ROOT, "mcp-server/node_modules/tsx/dist/cli.mjs"), join(ROOT, "packages/sdk/src/cli/create-connector.ts")];
  return spawnSync(process.execPath, [...cli, ...args], { cwd, encoding: "utf8" });
}

async function inTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "sdk-scaffold-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("skeleton depends on the SDK version that generated it", () => inTmp(async (dir) => {
  const r = runCli(dir, "demo-backend");
  assert.equal(r.status, 0, r.stderr);
  const pkg = JSON.parse(await readFile(join(dir, "demo-backend/package.json"), "utf8"));
  assert.equal(pkg.dependencies["@thotischner/observability-mcp-sdk"], `^${SDK_PKG.version}`);
  assert.equal(pkg.observabilityMcp.name, "demo-backend");
  const manifest = JSON.parse(await readFile(join(dir, "demo-backend/manifest.json"), "utf8"));
  assert.equal(manifest.name, "demo-backend");
  assert.ok(existsSync(join(dir, "demo-backend/src/index.ts")));
}));

test("rejects a non-kebab-case name without writing anything", () => inTmp(async (dir) => {
  const r = runCli(dir, "Bad_Name");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /kebab-case/);
  assert.ok(!existsSync(join(dir, "Bad_Name")));
}));

test("refuses to overwrite an existing directory", () => inTmp(async (dir) => {
  assert.equal(runCli(dir, "demo-backend").status, 0);
  const r = runCli(dir, "demo-backend");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Refusing to overwrite/);
}));
