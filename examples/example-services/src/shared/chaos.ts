import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { serviceCpuUsage, serviceMemoryUsage } from "./metrics.js";
import { log } from "./logger.js";

interface ChaosState {
  highCpu: boolean;
  errorSpike: boolean;
  slowResponses: boolean;
  memoryLeak: boolean;
}

const state: ChaosState = {
  highCpu: false,
  errorSpike: false,
  slowResponses: false,
  memoryLeak: false,
};

const timers: NodeJS.Timeout[] = [];

function clearChaosTimers() {
  timers.forEach(clearTimeout);
  timers.length = 0;
}

function scheduleReset(key: keyof ChaosState, durationMs = 60_000) {
  const timer = setTimeout(() => {
    state[key] = false;
    log("info", `Chaos "${key}" auto-reset after ${durationMs / 1000}s`);
  }, durationMs);
  timers.push(timer);
}

// Background loop: update simulated gauges with cross-signal correlation
let memoryLeakProgress = 0;
setInterval(() => {
  const baseCpu = 10 + Math.random() * 15;
  const baseMemory = 100_000_000 + Math.random() * 50_000_000;

  // CPU: affected by highCpu, errorSpike (processing retries), slowResponses (thread saturation)
  let cpu = baseCpu;
  if (state.highCpu) cpu = 85 + Math.random() * 13;
  else if (state.errorSpike) cpu += 15 + Math.random() * 10;  // error handling overhead
  else if (state.slowResponses) cpu += 5 + Math.random() * 5; // thread saturation
  serviceCpuUsage.set(cpu);

  // Memory: gradual ramp during leak, slight bump during error spike
  let memory = baseMemory;
  if (state.memoryLeak) {
    memoryLeakProgress = Math.min(memoryLeakProgress + 0.02, 1);
    memory = baseMemory * (1 + memoryLeakProgress * 3);
  } else {
    memoryLeakProgress = Math.max(memoryLeakProgress - 0.1, 0);
    if (state.errorSpike) memory *= 1.3; // error buffers
  }
  serviceMemoryUsage.set(memory);

  // Log errors during memory leak (OOM warnings)
  if (state.memoryLeak && memoryLeakProgress > 0.5 && Math.random() < 0.3) {
    log("error", "OutOfMemoryWarning: heap usage exceeding threshold", {
      heap_used_mb: Math.round(memory / 1_000_000),
      threshold_mb: 200,
      chaos: "memory-leak",
    });
  }
}, 1000);

export const chaosRouter = Router();

chaosRouter.post("/chaos/high-cpu", (_req: Request, res: Response) => {
  state.highCpu = true;
  scheduleReset("highCpu");
  log("warn", "Chaos activated: high-cpu", { chaos: "high-cpu" });
  res.json({ activated: "high-cpu", duration: "60s" });
});

chaosRouter.post("/chaos/error-spike", (_req: Request, res: Response) => {
  state.errorSpike = true;
  scheduleReset("errorSpike");
  log("warn", "Chaos activated: error-spike", { chaos: "error-spike" });
  res.json({ activated: "error-spike", duration: "60s" });
});

chaosRouter.post("/chaos/slow-responses", (_req: Request, res: Response) => {
  state.slowResponses = true;
  scheduleReset("slowResponses");
  log("warn", "Chaos activated: slow-responses", { chaos: "slow-responses" });
  res.json({ activated: "slow-responses", duration: "60s" });
});

chaosRouter.post("/chaos/memory-leak", (_req: Request, res: Response) => {
  state.memoryLeak = true;
  memoryLeakProgress = 0;
  scheduleReset("memoryLeak");
  log("warn", "Chaos activated: memory-leak", { chaos: "memory-leak" });
  res.json({ activated: "memory-leak", duration: "60s" });
});

chaosRouter.post("/chaos/reset", (_req: Request, res: Response) => {
  clearChaosTimers();
  state.highCpu = false;
  state.errorSpike = false;
  state.slowResponses = false;
  state.memoryLeak = false;
  memoryLeakProgress = 0;
  log("info", "All chaos conditions reset");
  res.json({ status: "all chaos cleared" });
});

chaosRouter.get("/chaos/status", (_req: Request, res: Response) => {
  res.json(state);
});

/** Middleware that injects chaos behavior into requests */
export function chaosMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.path.startsWith("/chaos") || req.path === "/metrics" || req.path === "/health") {
    next();
    return;
  }

  // Error spike: 50% of requests fail with 500, also log errors
  if (state.errorSpike && Math.random() < 0.5) {
    log("error", `Request failed: internal error during ${req.method} ${req.path}`, {
      chaos: "error-spike",
      method: req.method,
      path: req.path,
      error_code: "INTERNAL_ERROR",
    });
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }

  // Slow responses: 2-5s delay, also log warnings
  if (state.slowResponses) {
    const delay = 2000 + Math.random() * 3000;
    log("warn", `Slow response: ${Math.round(delay)}ms delay on ${req.method} ${req.path}`, {
      chaos: "slow-responses",
      delay_ms: Math.round(delay),
    });
    setTimeout(() => next(), delay);
    return;
  }

  // High CPU: slight request latency increase
  if (state.highCpu) {
    const delay = 200 + Math.random() * 500;
    setTimeout(() => next(), delay);
    return;
  }

  next();
}
