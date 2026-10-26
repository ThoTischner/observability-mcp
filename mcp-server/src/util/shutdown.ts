// Graceful shutdown. Components register a flush hook instead of their own
// process.on("SIGTERM") — any SIGTERM listener disables Node's default
// exit, and none of the old per-component handlers ever exited, so the
// server ignored SIGTERM and was SIGKILLed by Kubernetes/Docker after the
// grace period, sometimes mid-flush.
//
// On the first SIGTERM/SIGINT: flip readiness, stop accepting connections,
// drain in-flight requests briefly, run every hook in parallel (bounded by
// a timeout), exit 0. A second signal exits 1 immediately.

type Hook = { name: string; fn: () => unknown };

export interface ShutdownDeps {
  exit: (code: number) => void;
  log: (msg: string) => void;
  signals: Pick<NodeJS.Process, "once">;
}

const hooks: Hook[] = [];
let installed = false;
let shuttingDown = false;

/** Register work to run before the process exits (flush buffers, close clients). */
export function onShutdown(name: string, fn: () => unknown): void {
  hooks.push({ name, fn });
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Runs all hooks concurrently; resolves when they settle or the timeout hits. */
export async function runShutdownHooks(timeoutMs: number, log: (msg: string) => void): Promise<void> {
  const settled = Promise.allSettled(
    hooks.map(async (h) => {
      try {
        await h.fn();
      } catch (err) {
        log(`shutdown hook "${h.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((ok) => {
    timer = setTimeout(() => ok("timeout"), timeoutMs);
    timer.unref();
  });
  const outcome = await Promise.race([settled, timedOut]);
  clearTimeout(timer);
  if (outcome === "timeout") log(`shutdown hooks did not finish within ${timeoutMs}ms; exiting anyway`);
}

export function installShutdown(opts: {
  server?: {
    close(cb?: (err?: Error) => void): unknown;
    closeIdleConnections?(): void;
    closeAllConnections?(): void;
  };
  timeoutMs?: number;
  drainMs?: number;
  deps?: Partial<ShutdownDeps>;
} = {}): void {
  if (installed) return;
  installed = true;
  const exit = opts.deps?.exit ?? ((code: number) => process.exit(code));
  const log = opts.deps?.log ?? ((msg: string) => console.log(msg));
  const signals = opts.deps?.signals ?? process;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const drainMs = opts.drainMs ?? 3_000;

  const handle = (sig: string) => {
    if (shuttingDown) {
      log(`${sig} received again; exiting now`);
      exit(1);
      return;
    }
    shuttingDown = true;
    log(`${sig} received; shutting down (${hooks.length} hook(s), timeout ${timeoutMs}ms)`);
    // A second signal must still be able to force the exit.
    signals.once(sig as NodeJS.Signals, () => handle(sig));
    void (async () => {
      // Stop accepting first; the drain below lets in-flight requests finish.
      const server = opts.server;
      const closed = server
        ? new Promise<void>((ok) => {
            server.close(() => ok());
            server.closeIdleConnections?.();
          })
        : Promise.resolve();
      // Let in-flight requests finish (and write their audit entries)
      // before flushing; long-lived streams (SSE, WebSocket) would hold
      // close() open indefinitely, hence the bound.
      await Promise.race([closed, new Promise((ok) => setTimeout(ok, drainMs).unref())]);
      server?.closeAllConnections?.();
      await runShutdownHooks(timeoutMs, log);
      exit(0);
    })();
  };
  for (const sig of ["SIGTERM", "SIGINT"] as const) signals.once(sig, () => handle(sig));
}

/** Test-only. */
export function _resetShutdownForTests(): void {
  hooks.length = 0;
  installed = false;
  shuttingDown = false;
}
