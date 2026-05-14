import express from "express";
import { metricsMiddleware, metricsHandler } from "./shared/metrics.js";
import { chaosRouter, chaosMiddleware } from "./shared/chaos.js";
import { log } from "./shared/logger.js";
import { startTrafficGenerator } from "./shared/traffic.js";

const app = express();
const PORT = parseInt(process.env.PORT || "8081");

app.use(express.json());
app.use(metricsMiddleware);
app.use(chaosMiddleware);
app.use(chaosRouter);

app.get("/metrics", metricsHandler);

app.get("/health", (_req, res) => {
  res.json({ service: "payment-service", status: "ok", timestamp: new Date().toISOString() });
});

app.get("/", (_req, res) => {
  res.json({ service: "payment-service", status: "ok" });
});

app.post("/payments", async (req, res) => {
  const latency = 100 + Math.random() * 200;
  await new Promise((r) => setTimeout(r, latency));
  const paymentId = Math.floor(Math.random() * 100000);
  log("info", "Payment processed", {
    payment_id: paymentId,
    amount: req.body?.amount || 0,
    latency_ms: Math.round(latency),
  });
  res.json({ id: paymentId, status: "success", latency_ms: Math.round(latency) });
});

app.post("/refunds", async (req, res) => {
  const latency = 150 + Math.random() * 250;
  await new Promise((r) => setTimeout(r, latency));
  log("info", "Refund processed", { payment_id: req.body?.payment_id, latency_ms: Math.round(latency) });
  res.json({ status: "refunded" });
});

app.listen(PORT, () => {
  log("info", `payment-service listening on port ${PORT}`);

  startTrafficGenerator(PORT, [
    { method: "GET", path: "/" },
    { method: "POST", path: "/payments", body: { amount: 49.99 } },
    { method: "POST", path: "/refunds", body: { payment_id: 1 } },
  ], [], 4000);
});
