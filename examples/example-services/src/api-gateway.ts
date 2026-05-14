import express from "express";
import { metricsMiddleware, metricsHandler } from "./shared/metrics.js";
import { chaosRouter, chaosMiddleware } from "./shared/chaos.js";
import { log } from "./shared/logger.js";
import { startTrafficGenerator } from "./shared/traffic.js";

const app = express();
const PORT = parseInt(process.env.PORT || "8080");

app.use(express.json());
app.use(metricsMiddleware);
app.use(chaosMiddleware);
app.use(chaosRouter);

app.get("/metrics", metricsHandler);

app.get("/health", (_req, res) => {
  res.json({ service: "api-gateway", status: "ok", timestamp: new Date().toISOString() });
});

app.get("/", (_req, res) => {
  log("info", "Root endpoint called");
  res.json({ service: "api-gateway", status: "ok" });
});

app.get("/api/orders", async (_req, res) => {
  const latency = 50 + Math.random() * 150;
  await new Promise((r) => setTimeout(r, latency));
  log("info", "Proxied request to order-service", { latency_ms: Math.round(latency) });
  res.json({ orders: [{ id: 1, status: "completed" }, { id: 2, status: "pending" }] });
});

app.get("/api/payments", async (_req, res) => {
  const latency = 30 + Math.random() * 100;
  await new Promise((r) => setTimeout(r, latency));
  log("info", "Proxied request to payment-service", { latency_ms: Math.round(latency) });
  res.json({ payments: [{ id: 1, amount: 49.99, status: "success" }] });
});

app.listen(PORT, () => {
  log("info", `api-gateway listening on port ${PORT}`);

  startTrafficGenerator(PORT, [
    { method: "GET", path: "/" },
    { method: "GET", path: "/api/orders" },
    { method: "GET", path: "/api/payments" },
  ], [
    "http://payment-service:8081/payments",
    "http://order-service:8082/orders",
  ], 2000);
});
