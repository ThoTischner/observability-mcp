// End-to-end check that self-tracing actually exports. initOtel() degrades
// to "disabled" with a warning when the SDK API doesn't match, so an OTel
// upgrade can silently switch tracing off while every other test stays
// green. This boots the real server with tracing on, points it at a local
// OTLP/HTTP receiver, sends requests and waits for their spans.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SERVICE = "omcp-otel-export-test";

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined> | T | undefined, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

test("server exports HTTP spans with its service.name to the OTLP endpoint", { timeout: 150_000 }, async () => {
  const exports: Buffer[] = [];
  const receiver = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/traces") exports.push(await readBody(req));
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((ok) => receiver.listen(0, "127.0.0.1", ok));
  const otlpPort = (receiver.address() as AddressInfo).port;

  const port = await freePort();
  const work = mkdtempSync(join(tmpdir(), "omcp-otel-"));
  let log = "";
  // Inherited OTEL_* settings (e.g. OTEL_SDK_DISABLED in CI) must not
  // change what the server does here.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("OTEL_")),
  );
  const server = spawn(
    process.execPath,
    [join(ROOT, "node_modules/tsx/dist/cli.mjs"), join(ROOT, "src/index.ts")],
    {
      cwd: ROOT,
      env: {
        ...env,
        PORT: String(port),
        CONFIG_PATH: join(work, "sources.yaml"),
        OMCP_OTEL_ENABLED: "true",
        OMCP_OTEL_ENDPOINT: `http://127.0.0.1:${otlpPort}/v1/traces`,
        OMCP_OTEL_SERVICE_NAME: SERVICE,
        OTEL_BSP_SCHEDULE_DELAY: "200",
      },
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group: tsx runs the server as a child process.
      detached: true,
    },
  );
  const exited = new Promise((ok) => server.once("exit", ok));
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));

  try {
    await waitFor("server /healthz", async () => {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined);
      return r?.ok ? true : undefined;
    }, 60_000).catch((e) => { throw new Error(`${e.message}\n--- server log ---\n${log}`); });

    assert.match(log, /OTel self-tracing enabled/, `tracing did not start:\n${log}`);
    assert.doesNotMatch(log, /OTel init failed/, log);

    for (let i = 0; i < 3; i++) await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => undefined);

    // The HTTP exporter sends OTLP/JSON; match the resource and an HTTP
    // server span rather than raw bytes.
    const found = await waitFor("an exported HTTP server span", () => {
      for (const body of exports) {
        let doc: any;
        try { doc = JSON.parse(body.toString("utf8")); } catch { continue; }
        for (const rs of doc.resourceSpans ?? []) {
          const svc = (rs.resource?.attributes ?? []).find((a: any) => a.key === "service.name")?.value?.stringValue;
          if (svc !== SERVICE) continue;
          const spans = (rs.scopeSpans ?? []).flatMap((s: any) => s.spans ?? []);
          // SpanKind SERVER = 2 in OTLP/JSON.
          const http = spans.find((s: any) => s.kind === 2 || s.kind === "SPAN_KIND_SERVER");
          if (http) return http;
        }
      }
      return undefined;
    }, 30_000).catch((e) => {
      throw new Error(`${e.message}; ${exports.length} export request(s) received\n--- server log ---\n${log}`);
    });
    assert.ok(found.name, "exported span has a name");
  } finally {
    server.kill("SIGTERM");
    const stopped = await Promise.race([exited, new Promise((ok) => setTimeout(() => ok("hung"), 20_000).unref())]);
    // Also reaps a server child left behind if only the tsx wrapper exited.
    try { process.kill(-server.pid!, "SIGKILL"); } catch { /* group already gone */ }
    await new Promise<void>((ok) => receiver.close(() => ok()));
    rmSync(work, { recursive: true, force: true });
    assert.notEqual(stopped, "hung", `server still running 20s after SIGTERM\n${log}`);
  }
});
