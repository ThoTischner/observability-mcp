import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { installShutdown, onShutdown, isShuttingDown, _resetShutdownForTests } from "./shutdown.js";

beforeEach(() => _resetShutdownForTests());

function harness() {
  const signals = new EventEmitter();
  const events: string[] = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((ok) => (resolveExit = ok));
  const server = {
    close(cb?: () => void) { events.push("server.close"); setTimeout(() => cb?.(), 5); },
    closeIdleConnections() { events.push("closeIdle"); },
    closeAllConnections() { events.push("closeAll"); },
  };
  const deps = {
    exit: (code: number) => { events.push(`exit ${code}`); resolveExit(code); },
    log: (msg: string) => events.push(`log ${msg}`),
    signals: signals as unknown as Pick<NodeJS.Process, "once">,
  };
  return { signals, events, exited, server, deps };
}

test("SIGTERM stops accepting, drains, runs every hook, then exits 0", async () => {
  const h = harness();
  const ran: string[] = [];
  onShutdown("a", async () => { await new Promise((r) => setTimeout(r, 10)); ran.push("a"); h.events.push("hook a"); });
  onShutdown("b", () => { ran.push("b"); h.events.push("hook b"); });
  installShutdown({ server: h.server, deps: h.deps, drainMs: 50 });

  assert.equal(isShuttingDown(), false);
  h.signals.emit("SIGTERM");
  assert.equal(isShuttingDown(), true);
  assert.equal(await h.exited, 0);
  assert.deepEqual(ran.sort(), ["a", "b"]);
  const order = h.events.filter((e) => !e.startsWith("log"));
  assert.deepEqual(order, ["server.close", "closeIdle", "closeAll", "hook b", "hook a", "exit 0"]);
});

test("a failing hook is logged and does not block the others or the exit", async () => {
  const h = harness();
  let other = false;
  onShutdown("broken", () => { throw new Error("boom"); });
  onShutdown("fine", () => { other = true; });
  installShutdown({ deps: h.deps });
  h.signals.emit("SIGINT");
  assert.equal(await h.exited, 0);
  assert.ok(other);
  assert.ok(h.events.some((e) => e.includes('"broken" failed: boom')));
});

test("a hung hook can't keep the process alive past the timeout", async () => {
  const h = harness();
  // A hook stuck on a live handle (socket, timer) — the realistic hang.
  let stuck: NodeJS.Timeout | undefined;
  onShutdown("hangs", () => new Promise((r) => { stuck = setTimeout(r, 60_000); }));
  installShutdown({ deps: h.deps, timeoutMs: 50 });
  h.signals.emit("SIGTERM");
  assert.equal(await h.exited, 0);
  clearTimeout(stuck);
  assert.ok(h.events.some((e) => e.includes("did not finish within 50ms")));
});

test("a second signal forces exit 1", async () => {
  const h = harness();
  let slow: NodeJS.Timeout | undefined;
  onShutdown("slow", () => new Promise((r) => { slow = setTimeout(r, 60_000); }));
  installShutdown({ deps: h.deps, timeoutMs: 5000 });
  h.signals.emit("SIGTERM");
  h.signals.emit("SIGTERM");
  assert.equal(await h.exited, 1);
  clearTimeout(slow);
});
