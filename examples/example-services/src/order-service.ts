import express from "express";
import { metricsMiddleware, metricsHandler } from "./shared/metrics.js";
import { chaosRouter, chaosMiddleware } from "./shared/chaos.js";
import { log } from "./shared/logger.js";
import { startTrafficGenerator } from "./shared/traffic.js";

const app = express();
const PORT = parseInt(process.env.PORT || "8082");

app.use(express.json());
app.use(metricsMiddleware);
app.use(chaosMiddleware);
app.use(chaosRouter);

app.get("/metrics", metricsHandler);

app.get("/health", (_req, res) => {
  res.json({ service: "order-service", status: "ok", timestamp: new Date().toISOString() });
});

app.get("/", (_req, res) => {
  res.json({ service: "order-service", status: "ok" });
});

app.post("/orders", async (req, res) => {
  const latency = 80 + Math.random() * 120;
  await new Promise((r) => setTimeout(r, latency));
  const orderId = Math.floor(Math.random() * 100000);
  log("info", "Order created", {
    order_id: orderId,
    items: req.body?.items?.length || 0,
    latency_ms: Math.round(latency),
  });
  res.json({ id: orderId, status: "created" });
});

app.get("/orders", async (_req, res) => {
  const latency = 30 + Math.random() * 70;
  await new Promise((r) => setTimeout(r, latency));
  res.json({
    orders: [
      { id: 1, status: "completed", total: 99.99 },
      { id: 2, status: "pending", total: 149.50 },
    ],
  });
});

app.listen(PORT, () => {
  log("info", `order-service listening on port ${PORT}`);

  startTrafficGenerator(PORT, [
    { method: "GET", path: "/" },
    { method: "GET", path: "/orders" },
    { method: "POST", path: "/orders", body: { items: [{ id: 1, qty: 2 }] } },
  ], [], 5000);
});
