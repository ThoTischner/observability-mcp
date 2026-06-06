#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  statSync,
  cpSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  parseArgs,
  pickFreePort,
  composeOverride,
  resolveCatalogSource,
  formatPluginList,
  formatPluginInfo,
  resolveInstall,
  splitPassthrough,
  helmReleaseArgs,
  HELM_REPO_NAME,
  HELM_REPO_URL,
  HELP,
  type Catalog,
} from "./lib.js";
import {
  loadTrustRoot,
  verifyIntegrity,
  verifyManifestSignature,
  PluginVerificationError,
} from "../connectors/verify.js";
import { inspectorConfigCommand } from "./inspector-config.js";

function pkgVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/cli/index.js → ../../package.json
    return JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

function which(bin: string, args: string[] = ["--version"]): string | null {
  const r = spawnSync(bin, args, { encoding: "utf8" });
  if (r.status === 0) return (r.stdout || r.stderr || "").trim().split("\n")[0];
  return null;
}

function dockerComposeVersion(): string | null {
  const r = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout || "").trim().split("\n")[0] : null;
}

// Walk up from cwd looking for the repo's docker-compose.yml.
function findComposeFile(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const f = join(dir, "docker-compose.yml");
    if (existsSync(f)) return f;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Walk up from cwd for a checkout's generated catalog.
function findLocalCatalog(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const f = join(dir, "hub", "catalog", "index.json");
    if (existsSync(f)) return f;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function loadCatalog(from: string | undefined): Promise<Catalog> {
  const src = resolveCatalogSource(from, findLocalCatalog());
  if (src.kind === "file") {
    if (!existsSync(src.location)) fail(`catalog not found: ${src.location}`);
    return JSON.parse(readFileSync(src.location, "utf8")) as Catalog;
  }
  const r = await fetch(src.location).catch((e) => fail(`fetch failed: ${String(e)}`));
  if (!r.ok) fail(`catalog HTTP ${r.status} from ${src.location}`);
  return (await r.json()) as Catalog;
}

async function plugin(sub: string | undefined, args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const from = typeof flags.from === "string" ? flags.from : undefined;
  const json = flags.json === true;
  // `verify` operates on a local dir — no catalog needed (works offline).
  if (sub === "verify") {
    const dir = args[0];
    if (!dir) fail("usage: omcp plugin verify <dir> --trust-root <pem>");
    const abs = resolve(dir);
    if (!existsSync(abs)) fail(`directory not found: ${abs}`);
    verifyPluginDir(abs, flags);
    return;
  }
  const cat = await loadCatalog(from);
  if (sub === "list") {
    console.log(json ? JSON.stringify(cat, null, 2) : formatPluginList(cat));
    return;
  }
  if (sub === "info") {
    const name = args[0];
    if (!name) fail("usage: omcp plugin info <name>");
    const c = cat.connectors.find((x) => x.name === name);
    if (!c) fail(`no connector '${name}' in catalog (try: omcp plugin list)`);
    console.log(json ? JSON.stringify(c, null, 2) : formatPluginInfo(c));
    return;
  }
  if (sub === "install") {
    return installPlugin(cat, args[0], flags);
  }
  fail(`unknown 'plugin' subcommand: ${sub ?? "(none)"} (list|info|install|verify)`);
}

function tarExtract(tgz: string, dest: string): void {
  const r = spawnSync("tar", ["-xzf", tgz, "-C", dest], { stdio: "inherit" });
  if (r.status !== 0) fail(`tar extraction failed for ${tgz}`);
}

// Find the dir containing a package.json with the observabilityMcp
// connector marker (npm pack nests under package/; airgapped tarballs
// may not).
function findPluginRoot(base: string): string | null {
  const candidates = [base, ...readdirSync(base).map((e) => join(base, e))];
  for (const dir of candidates) {
    try {
      if (!statSync(dir).isDirectory()) continue;
      const pkgPath = join(dir, "package.json");
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.observabilityMcp?.kind === "connector") return dir;
    } catch {
      /* skip */
    }
  }
  return null;
}

// Shared fail-closed verification of an extracted/installed plugin dir.
// Used by `plugin install` and `plugin verify`. --insecure explicitly
// opts out; otherwise --trust-root is mandatory.
function verifyPluginDir(root: string, flags: Record<string, string | boolean>): void {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) fail(`no package.json in ${root}`);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg.observabilityMcp?.kind !== "connector") fail("not a connector (observabilityMcp marker)");
  const manifestRel = pkg.observabilityMcp?.manifest;
  if (!manifestRel) fail("package.json has no observabilityMcp.manifest");
  const manifestPath = resolve(root, manifestRel);
  if (!existsSync(manifestPath)) fail(`manifest not found: ${manifestRel}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entryPath = resolve(root, pkg.main || "index.js");

  if (flags.insecure === true) {
    console.warn("WARNING: --insecure — skipping signature + integrity verification.");
    return;
  }
  const trustRootPath = typeof flags["trust-root"] === "string" ? (flags["trust-root"] as string) : undefined;
  if (!trustRootPath) {
    fail("verification required: pass --trust-root <pem> (or --insecure to explicitly opt out)");
  }
  const sigPath = manifestPath + ".sig";
  if (!existsSync(sigPath)) fail(`missing manifest signature: ${manifestRel}.sig`);
  try {
    const trustRoot = loadTrustRoot(trustRootPath!);
    verifyManifestSignature(readFileSync(manifestPath), readFileSync(sigPath), trustRoot);
    verifyIntegrity(entryPath, manifest.integrity);
  } catch (e) {
    const msg = e instanceof PluginVerificationError ? e.message : String(e);
    fail(`verification failed (fail-closed): ${msg}`);
  }
  console.log(`signature + integrity OK (${pkg.observabilityMcp.name}@${manifest.version ?? "?"})`);
}

async function installPlugin(
  cat: Catalog,
  ref: string | undefined,
  flags: Record<string, string | boolean>
): Promise<void> {
  if (!ref) fail("usage: omcp plugin install <name>[@version]");
  let r;
  try {
    r = resolveInstall(cat, ref);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  if (r.builtin) {
    console.log(`'${r.name}' is builtin — it ships in the server image, no install needed.`);
    return;
  }

  const offlineDir = typeof flags["offline-dir"] === "string" ? (flags["offline-dir"] as string) : undefined;
  const dest = resolve(
    typeof flags.dest === "string" ? (flags.dest as string) : process.env.PLUGINS_DIR ?? "./plugins"
  );
  const targetDir = join(dest, r.name);
  if (existsSync(targetDir) && flags.force !== true) {
    fail(`${targetDir} already exists (pass --force to overwrite)`);
  }

  const work = mkdtempSync(join(tmpdir(), "omcp-inst-"));
  const tgz = join(work, "plugin.tgz");

  if (offlineDir) {
    const local = join(offlineDir, `${r.name}-${r.version}.tgz`);
    if (!existsSync(local)) fail(`offline tarball not found: ${local}`);
    cpSync(local, tgz);
  } else {
    if (!r.tarballUrl) fail(`catalog entry for ${r.name}@${r.version} has no tarballUrl`);
    const resp = await fetch(r.tarballUrl).catch((e) => fail(`download failed: ${String(e)}`));
    if (!resp.ok) fail(`tarball HTTP ${resp.status}`);
    writeFileSync(tgz, Buffer.from(await resp.arrayBuffer()));
  }

  const stage = join(work, "stage");
  mkdirSync(stage);
  tarExtract(tgz, stage);
  const root = findPluginRoot(stage);
  if (!root) fail("no connector package.json (observabilityMcp marker) in tarball");

  verifyPluginDir(root!, flags);

  mkdirSync(dest, { recursive: true });
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
  cpSync(root!, targetDir, { recursive: true });
  rmSync(work, { recursive: true, force: true });
  console.log(`installed ${r.name}@${r.version} → ${targetDir}`);
}

function portInUse(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ port, host });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(400);
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });
}

function fail(msg: string): never {
  console.error("error: " + msg);
  process.exit(1);
}

async function doctor(json: boolean): Promise<void> {
  const checks = {
    node: process.version,
    docker: which("docker"),
    "docker compose": dockerComposeVersion(),
    helm: which("helm", ["version", "--short"]),
    "compose file": findComposeFile() ?? null,
  };
  if (json) {
    console.log(JSON.stringify(checks, null, 2));
  } else {
    for (const [k, v] of Object.entries(checks)) {
      const ok = v != null;
      console.log(`${ok ? "ok  " : "MISS"}  ${k.padEnd(16)} ${ok ? v : "(not found)"}`);
    }
  }
  const required = ["docker", "docker compose"];
  if (required.some((k) => (checks as Record<string, unknown>)[k] == null)) {
    fail("missing required tooling (docker + docker compose)");
  }
}

async function demo(sub: string | undefined): Promise<void> {
  const compose = findComposeFile();
  if (!compose) fail("docker-compose.yml not found (run from an observability-mcp checkout)");
  const root = dirname(compose!);
  const baseArgs = ["compose", "-f", compose!];

  if (sub === "status") {
    run("docker", [...baseArgs, "--profile", "demo", "ps"], root);
    return;
  }
  if (sub === "down") {
    run("docker", [...baseArgs, "--profile", "demo", "down", "-v"], root);
    return;
  }
  if (sub !== "up") fail(`unknown 'demo' subcommand: ${sub ?? "(none)"} (up|down|status)`);

  // Auto-pick free host ports for the two services that commonly clash.
  const wanted: Array<{ service: string; container: number }> = [
    { service: "mcp-server", container: 3000 },
    { service: "loki", container: 3100 },
  ];
  const remaps: Array<{ service: string; host: number; container: number }> = [];
  for (const w of wanted) {
    const busy = await portInUse(w.container);
    let host = w.container;
    if (busy) {
      const used = new Set<number>();
      host = pickFreePort(w.container + 1, (p) => used.has(p));
      // Probe sequentially; mark scanned-busy ports so pickFreePort skips.
      for (let p = w.container + 1; p < w.container + 50; p++) {
        if (await portInUse(p)) used.add(p);
        else {
          host = p;
          break;
        }
      }
      console.log(`port ${w.container} busy → ${w.service} mapped to host ${host}`);
    }
    remaps.push({ service: w.service, host, container: w.container });
  }

  const args = [...baseArgs];
  const mcp = remaps.find((r) => r.service === "mcp-server")!;
  const needsOverride = remaps.some((r) => r.host !== r.container);
  if (needsOverride) {
    const dir = mkdtempSync(join(tmpdir(), "omcp-"));
    const ovr = join(dir, "override.yml");
    writeFileSync(ovr, composeOverride(remaps));
    args.push("-f", ovr);
  }
  args.push("--profile", "demo", "up", "--build", "-d");
  const code = run("docker", args, root);
  if (code === 0) {
    console.log(`\ndemo stack up. Web UI / MCP: http://localhost:${mcp.host}  (/mcp, /healthz)`);
    console.log("Stop with: omcp demo down");
  }
  process.exit(code);
}

function helm(sub: string | undefined, release: string, passthrough: string[]): void {
  if (sub !== "install" && sub !== "upgrade") {
    fail(`unknown 'helm' subcommand: ${sub ?? "(none)"} (install|upgrade)`);
  }
  if (!which("helm", ["version", "--short"])) {
    fail("helm not found on PATH (see: https://helm.sh/docs/intro/install/)");
  }
  const cwd = process.cwd();
  // Idempotent: --force-update tolerates an existing repo entry.
  if (run("helm", ["repo", "add", HELM_REPO_NAME, HELM_REPO_URL, "--force-update"], cwd) !== 0) {
    fail("helm repo add failed");
  }
  if (run("helm", ["repo", "update", HELM_REPO_NAME], cwd) !== 0) {
    fail("helm repo update failed");
  }
  const args = helmReleaseArgs(sub, release, passthrough);
  const code = run("helm", args, cwd);
  if (code === 0) {
    console.log(`\nhelm ${sub} ok: release '${release}' from the signed ${HELM_REPO_NAME} chart.`);
  }
  process.exit(code);
}

function run(cmd: string, args: string[], cwd: string): number {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  return r.status ?? 1;
}

async function main(): Promise<void> {
  const { argv: pre, passthrough } = splitPassthrough(process.argv.slice(2));
  const { command, sub, flags, positionals } = parseArgs(pre);
  const json = flags.json === true;
  switch (command) {
    case "":
    case "help":
    case "--help":
      console.log(HELP);
      return;
    case "version":
    case "--version":
      console.log(`omcp ${pkgVersion()}`);
      return;
    case "doctor":
      return doctor(json);
    case "demo":
      return demo(sub);
    case "plugin":
      return plugin(sub, positionals, flags);
    case "helm":
      return helm(sub, positionals[0] ?? "observability-mcp", passthrough);
    case "inspector-config":
      return inspectorConfigCommand();
    default:
      fail(`unknown command: ${command}\n\n${HELP}`);
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
