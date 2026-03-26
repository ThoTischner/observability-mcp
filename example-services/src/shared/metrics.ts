import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from "prom-client";
import type { Request, Response, NextFunction } from "express";

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const serviceCpuUsage = new Gauge({
  name: "service_cpu_usage_percent",
  help: "Simulated CPU usage percentage",
  registers: [registry],
});

export const serviceMemoryUsage = new Gauge({
  name: "service_memory_usage_bytes",
  help: "Simulated memory usage in bytes",
  registers: [registry],
});

// Initialize with baseline values
serviceCpuUsage.set(10 + Math.random() * 15);
serviceMemoryUsage.set(100_000_000 + Math.random() * 50_000_000);

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.path === "/metrics" || req.path === "/health") {
    next();
    return;
  }
  const start = Date.now();
  res.on("finish", () => {
    const duration = (Date.now() - start) / 1000;
    const route = req.route?.path || req.path;
    const labels = { method: req.method, route, status: String(res.statusCode) };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, duration);
  });
  next();
}

export async function metricsHandler(_req: Request, res: Response) {
  res.set("Content-Type", registry.contentType);
  res.end(await registry.metrics());
}
