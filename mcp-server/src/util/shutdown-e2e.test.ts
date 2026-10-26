// The real server must exit on SIGTERM. It used to register several
// flush-only SIGTERM listeners and never exit, so Kubernetes and Docker
// SIGKILLed it after the grace period.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}

test("server drains and exits 0 on SIGTERM", { timeout: 120_000 }, async () => {
  const port = await freePort();
  const work = mkdtempSync(join(tmpdir(), "omcp-shutdown-"));
  let log = "";
  const server = spawn(
    process.execPath,
    [join(ROOT, "node_modules/tsx/dist/cli.mjs"), join(ROOT, "src/index.ts")],
    {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), CONFIG_PATH: join(work, "sources.yaml") },
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group: tsx runs the server as a child, so a cleanup
      // kill must reach the whole group, not just the tsx wrapper.
      detached: true,
    },
  );
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  const exited = new Promise<number | null>((ok) => server.once("exit", (code) => ok(code)));

  try {
    const deadline = Date.now() + 90_000;
    for (;;) {
      const r = await fetch(`http://127.0.0.1:${port}/readyz`).catch(() => undefined);
      if (r?.ok) break;
      if (Date.now() > deadline) assert.fail(`server never became ready\n--- log ---\n${log}`);
      await new Promise((r) => setTimeout(r, 250));
    }

    const t0 = Date.now();
    server.kill("SIGTERM");
    const code = await Promise.race([
      exited,
      new Promise<"hung">((ok) => setTimeout(() => ok("hung"), 20_000).unref()),
    ]);
    assert.notEqual(code, "hung", `still running 20s after SIGTERM\n--- log ---\n${log}`);
    assert.equal(code, 0, log);
    assert.match(log, /SIGTERM received; shutting down/);
    assert.ok(Date.now() - t0 < 15_000);
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      try { process.kill(-server.pid!, "SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(work, { recursive: true, force: true });
  }
});

test("stdio mode flushes and exits 0 on SIGTERM too", { timeout: 120_000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), "omcp-shutdown-stdio-"));
  let log = "";
  const server = spawn(
    process.execPath,
    [join(ROOT, "node_modules/tsx/dist/cli.mjs"), join(ROOT, "src/index.ts")],
    {
      cwd: ROOT,
      env: { ...process.env, MCP_TRANSPORT: "stdio", CONFIG_PATH: join(work, "sources.yaml") },
      // stdin stays open: a closed stdin would end the session on its own.
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    },
  );
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  const exited = new Promise<number | null>((ok) => server.once("exit", (code) => ok(code)));

  try {
    const deadline = Date.now() + 90_000;
    while (!/running on stdio transport/.test(log)) {
      if (Date.now() > deadline) assert.fail(`stdio server never started\n--- log ---\n${log}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    server.kill("SIGTERM");
    const code = await Promise.race([
      exited,
      new Promise<"hung">((ok) => setTimeout(() => ok("hung"), 20_000).unref()),
    ]);
    assert.notEqual(code, "hung", `still running 20s after SIGTERM\n--- log ---\n${log}`);
    assert.equal(code, 0, log);
    assert.match(log, /SIGTERM received; shutting down \([1-9]\d* hook/);
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      try { process.kill(-server.pid!, "SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(work, { recursive: true, force: true });
  }
});
