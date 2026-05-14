import { log } from "./logger.js";

/**
 * Starts a background traffic generator that periodically sends requests
 * to the service's own endpoints and optionally to downstream services.
 */
export function startTrafficGenerator(
  selfPort: number,
  endpoints: { method: string; path: string; body?: unknown }[],
  downstreamUrls: string[] = [],
  intervalMs: number = 3000
) {
  const selfBase = `http://localhost:${selfPort}`;

  async function tick() {
    // Hit a random own endpoint
    const ep = endpoints[Math.floor(Math.random() * endpoints.length)];
    try {
      await fetch(`${selfBase}${ep.path}`, {
        method: ep.method,
        headers: ep.body ? { "Content-Type": "application/json" } : undefined,
        body: ep.body ? JSON.stringify(ep.body) : undefined,
      });
    } catch {
      // Expected during startup or chaos
    }

    // Hit a random downstream service (if any)
    if (downstreamUrls.length > 0 && Math.random() < 0.5) {
      const url = downstreamUrls[Math.floor(Math.random() * downstreamUrls.length)];
      try {
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ generated: true, timestamp: Date.now() }),
        });
      } catch {
        // Downstream may be unreachable during startup
      }
    }
  }

  // Start after a short delay to let the server bind
  setTimeout(() => {
    log("info", `Traffic generator started (interval: ${intervalMs}ms, endpoints: ${endpoints.length}, downstream: ${downstreamUrls.length})`);
    setInterval(tick, intervalMs);
    // Immediate first batch
    tick();
  }, 2000);
}
