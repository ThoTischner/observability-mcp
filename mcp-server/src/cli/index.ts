#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  parseArgs,
  pickFreePort,
  composeOverride,
  resolveCatalogSource,
  formatPluginList,
  formatPluginInfo,
  HELP,
  type Catalog,
} from "./lib.js";

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
  fail(`unknown 'plugin' subcommand: ${sub ?? "(none)"} (list|info)`);
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

function run(cmd: string, args: string[], cwd: string): number {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  return r.status ?? 1;
}

async function main(): Promise<void> {
  const { command, sub, flags, positionals } = parseArgs(process.argv.slice(2));
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
    default:
      fail(`unknown command: ${command}\n\n${HELP}`);
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
