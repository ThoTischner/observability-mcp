#!/usr/bin/env node
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { loadConfig, saveConfig, DEFAULT_HEALTH_THRESHOLDS, DEFAULT_SETTINGS } from "./config/loader.js";
import { ConnectorRegistry, getSupportedTypes } from "./connectors/registry.js";
import { listSourcesHandler } from "./tools/list-sources.js";
import { listServicesHandler } from "./tools/list-services.js";
import { queryMetricsHandler } from "./tools/query-metrics.js";
import { queryLogsHandler } from "./tools/query-logs.js";
import { getServiceHealthHandler, setHealthThresholds } from "./tools/get-service-health.js";
import { detectAnomaliesHandler } from "./tools/detect-anomalies.js";
import type { Config } from "./types.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function applyConfigToRuntime(config: Config, registry: ConnectorRegistry) {
  setHealthThresholds(config.healthThresholds);
}

/** Build a dynamic description of available metrics from all connected sources */
function getAvailableMetricNames(registry: ConnectorRegistry): string {
  const allMetrics = new Map<string, string>(); // name → description
  for (const connector of registry.getBySignal("metrics")) {
    for (const m of connector.getMetrics()) {
      if (!allMetrics.has(m.name)) {
        allMetrics.set(m.name, m.description || m.name);
      }
    }
  }
  if (allMetrics.size === 0) return "No metrics sources configured.";
  return Array.from(allMetrics.entries())
    .map(([name, desc]) => `${name} (${desc})`)
    .join(", ");
}

/** Validate source URL: must be http/https, reject obviously dangerous targets */
function validateSourceUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return `Invalid URL scheme "${parsed.protocol}". Only http and https are allowed.`;
    }
    // Block cloud metadata endpoints
    const host = parsed.hostname.toLowerCase();
    if (host === "169.254.169.254" || host === "metadata.google.internal") {
      return "Access to cloud metadata endpoints is not allowed.";
    }
    return null;
  } catch {
    return `Invalid URL: "${url}"`;
  }
}

async function main() {
  let config = loadConfig();
  const registry = new ConnectorRegistry();
  await registry.initialize(config);
  applyConfigToRuntime(config, registry);

  const mcpServer = new McpServer({
    name: "observability-mcp",
    version: "1.0.0",
  });

  // --- Register tools with Zod schemas ---

  mcpServer.tool(
    "list_sources",
    "List all configured observability backends and their connection status. Use this to discover what data sources are available.",
    {},
    async () => listSourcesHandler(registry)
  );

  mcpServer.tool(
    "list_services",
    "List all monitored services discovered across all connected backends. Returns service names, their data sources, and signal types (metrics/logs).",
    { filter: z.string().optional().describe("Optional filter to match service names") },
    async (args) => listServicesHandler(registry, args)
  );

  const metricsList = getAvailableMetricNames(registry);
  const metricNames = registry.getBySignal("metrics").flatMap(c => c.getMetrics().map(m => m.name));
  const uniqueNames = [...new Set(metricNames)];

  mcpServer.tool(
    "query_metrics",
    `Query a specific metric for a service over a given timeframe. Returns time-series data with pre-computed summary statistics (current, average, min, max, trend). Available metrics: ${metricsList}`,
    {
      service: z.string().describe("Service name (e.g. 'api-gateway', 'payment-service')"),
      metric: z.string().describe(`Metric name. Available: ${uniqueNames.join(", ")}`),
      duration: z.string().optional().describe("Time range (e.g. '5m', '1h', '24h'). Default: '5m'"),
      source: z.string().optional().describe("Specific source name. If omitted, queries all metrics backends."),
      groupBy: z.string().optional().describe("Label to break the result down by, e.g. 'instance', 'pod', 'node'. Returns one series per distinct value in 'groups'."),
    },
    async (args) => queryMetricsHandler(registry, args)
  );

  mcpServer.tool(
    "query_logs",
    "Query logs for a service over a given timeframe. Returns log entries with a summary including error/warning counts and top error patterns.",
    {
      service: z.string().describe("Service name (e.g. 'payment-service')"),
      query: z.string().optional().describe("Optional search query to filter log messages (regex supported)"),
      duration: z.string().optional().describe("Time range (e.g. '5m', '1h', '24h'). Default: '5m'"),
      level: z.string().optional().describe("Filter by log level: 'error', 'warn', 'info', 'debug'"),
      limit: z.number().optional().describe("Maximum log entries to return. Default: 100"),
    },
    async (args) => queryLogsHandler(registry, args)
  );

  mcpServer.tool(
    "get_service_health",
    "Get an aggregated health overview for a service combining metrics AND logs. Returns health score (0-100), status (healthy/degraded/critical), key metrics, log error summary, anomalies, and cross-signal correlations.",
    {
      service: z.string().describe("Service name to check health for"),
    },
    async (args) => getServiceHealthHandler(registry, args)
  );

  mcpServer.tool(
    "detect_anomalies",
    "Scan for anomalies across all monitored services (or a specific one). Uses z-score analysis on metrics, checks log error spikes, and correlates signals. Returns anomalies with severity ratings.",
    {
      service: z.string().optional().describe("Specific service to scan. If omitted, scans all."),
      duration: z.string().optional().describe("Time range to analyze (e.g. '5m', '15m', '1h'). Default: '10m'"),
      sensitivity: z.enum(["low", "medium", "high"]).optional().describe("Detection sensitivity: low (>3σ), medium (>2σ), high (>1.5σ). Default: 'medium'"),
    },
    async (args) => detectAnomaliesHandler(registry, args)
  );

  // --- HTTP server ---
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  // Serve Web UI
  app.use(express.static(join(__dirname, "ui")));

  // --- API endpoints for Web UI ---

  // List sources with health status
  app.get("/api/sources", async (_req, res) => {
    const health = await registry.healthCheckAll();
    const configs = registry.getSourceConfigs();
    const sources = configs.map((c) => {
      const connector = registry.getByName(c.name);
      return {
        name: c.name,
        type: c.type,
        url: c.url,
        enabled: c.enabled,
        auth: c.auth ? { type: c.auth.type } : undefined,
        tls: c.tls || undefined,
        signalType: connector?.signalType || null,
        status: health[c.name]?.status || (c.enabled ? "down" : "disabled"),
        latencyMs: health[c.name]?.latencyMs || null,
        message: health[c.name]?.message || null,
      };
    });
    res.json(sources);
  });

  // Get supported connector types
  app.get("/api/source-types", (_req, res) => {
    res.json(getSupportedTypes());
  });

  // Add a new source
  app.post("/api/sources", async (req, res) => {
    const { name, type, url, enabled, auth, tls } = req.body;
    if (!name || !type || !url) {
      res.status(400).json({ error: "name, type, and url are required" });
      return;
    }
    const urlErr = validateSourceUrl(url);
    if (urlErr) { res.status(400).json({ error: urlErr }); return; }
    const existing = registry.getSourceConfigs().find((s) => s.name === name);
    if (existing) {
      res.status(409).json({ error: `Source "${name}" already exists` });
      return;
    }
    const source = { name, type, url, enabled: enabled !== false, auth, tls };
    await registry.addSource(source);
    saveConfig(config = { ...config, sources: registry.getSourceConfigs() });
    res.status(201).json({ ok: true, source });
  });

  // Update an existing source
  app.put("/api/sources/:name", async (req, res) => {
    const oldName = req.params.name;
    const { name, type, url, enabled, auth, tls } = req.body;
    const existing = registry.getSourceConfigs().find((s) => s.name === oldName);
    if (!existing) {
      res.status(404).json({ error: `Source "${oldName}" not found` });
      return;
    }
    const newUrl = url || existing.url;
    if (url) {
      const urlErr = validateSourceUrl(newUrl);
      if (urlErr) { res.status(400).json({ error: urlErr }); return; }
    }
    const source = {
      name: name || oldName,
      type: type || existing.type,
      url: newUrl,
      enabled: enabled !== undefined ? enabled : existing.enabled,
      auth: auth !== undefined ? auth : existing.auth,
      tls: tls !== undefined ? tls : existing.tls,
    };
    await registry.updateSource(oldName, source);
    saveConfig(config = { ...config, sources: registry.getSourceConfigs() });
    res.json({ ok: true, source });
  });

  // Delete a source
  app.delete("/api/sources/:name", async (req, res) => {
    const name = req.params.name;
    const existing = registry.getSourceConfigs().find((s) => s.name === name);
    if (!existing) {
      res.status(404).json({ error: `Source "${name}" not found` });
      return;
    }
    await registry.removeSource(name);
    saveConfig(config = { ...config, sources: registry.getSourceConfigs() });
    res.json({ ok: true });
  });

  // Test a source connection (without saving)
  app.post("/api/sources/test", async (req, res) => {
    const { name, type, url, enabled, auth, tls } = req.body;
    if (!type || !url) {
      res.status(400).json({ error: "type and url are required" });
      return;
    }
    const urlErr = validateSourceUrl(url);
    if (urlErr) { res.status(400).json({ error: urlErr }); return; }
    const result = await registry.testConnection({
      name: name || "test",
      type,
      url,
      enabled: enabled !== false,
      auth,
      tls,
    });
    res.json(result);
  });

  // Toggle source enabled/disabled
  app.patch("/api/sources/:name/toggle", async (req, res) => {
    const name = req.params.name;
    const existing = registry.getSourceConfigs().find((s) => s.name === name);
    if (!existing) {
      res.status(404).json({ error: `Source "${name}" not found` });
      return;
    }
    const updated = { ...existing, enabled: !existing.enabled };
    await registry.updateSource(name, updated);
    saveConfig(config = { ...config, sources: registry.getSourceConfigs() });
    res.json({ ok: true, enabled: updated.enabled });
  });

  /** Safely parse JSON from MCP tool result */
  function parseToolResult(result: { content: Array<{ text: string }> }): unknown {
    try { return JSON.parse(result.content[0]?.text || "{}"); }
    catch { return { error: "Failed to parse tool result" }; }
  }

  // List discovered services
  app.get("/api/services", async (_req, res) => {
    try {
      const result = await listServicesHandler(registry, {});
      res.json(parseToolResult(result));
    } catch { res.status(500).json({ error: "Failed to list services" }); }
  });

  // Health endpoint for UI dashboard
  app.get("/api/health/:service", async (req, res) => {
    try {
      const result = await getServiceHealthHandler(registry, { service: req.params.service });
      res.json(parseToolResult(result));
    } catch {
      res.status(500).json({ error: "Failed to get service health" });
    }
  });

  // Health for all services
  app.get("/api/health", async (_req, res) => {
    try {
      const servicesResult = await listServicesHandler(registry, {});
      const parsed = parseToolResult(servicesResult) as { services?: Array<{ name: string }> };
      const services = parsed?.services || [];
      const health: Record<string, unknown> = {};
      for (const svc of services) {
        try {
          const result = await getServiceHealthHandler(registry, { service: svc.name });
          health[svc.name] = parseToolResult(result);
        } catch { health[svc.name] = { error: "failed to fetch health" }; }
      }
      res.json(health);
    } catch {
      res.status(500).json({ error: "Failed to get health data" });
    }
  });

  // --- Settings API ---

  // Get general settings
  app.get("/api/settings", (_req, res) => {
    res.json(config.settings);
  });

  // Update general settings
  app.put("/api/settings", (req, res) => {
    config = { ...config, settings: { ...config.settings, ...req.body } };
    saveConfig(config);
    res.json({ ok: true, settings: config.settings });
  });

  // Get defaults (for reset buttons in UI)
  app.get("/api/settings/defaults", (_req, res) => {
    res.json({
      settings: DEFAULT_SETTINGS,
      healthThresholds: DEFAULT_HEALTH_THRESHOLDS,
    });
  });

  // --- Health Thresholds API ---

  app.get("/api/health-thresholds", (_req, res) => {
    res.json(config.healthThresholds);
  });

  app.put("/api/health-thresholds", (req, res) => {
    config = { ...config, healthThresholds: { ...config.healthThresholds, ...req.body } };
    applyConfigToRuntime(config, registry);
    saveConfig(config);
    res.json({ ok: true, healthThresholds: config.healthThresholds });
  });

  // --- Per-Source Metrics API ---

  // Get metrics for a source (active metrics or defaults)
  app.get("/api/sources/:name/metrics", (req, res) => {
    const connector = registry.getByName(req.params.name);
    if (!connector) {
      res.status(404).json({ error: `Source "${req.params.name}" not found` });
      return;
    }
    res.json({
      metrics: connector.getMetrics(),
      defaults: connector.getDefaultMetrics(),
    });
  });

  // Update metrics for a source
  app.put("/api/sources/:name/metrics", async (req, res) => {
    const name = req.params.name;
    const sourceIdx = config.sources.findIndex((s) => s.name === name);
    if (sourceIdx === -1) {
      res.status(404).json({ error: `Source "${name}" not found` });
      return;
    }
    config.sources[sourceIdx].metrics = req.body.metrics || [];
    // Reconnect to pick up new metrics
    await registry.updateSource(name, config.sources[sourceIdx]);
    saveConfig(config);
    res.json({ ok: true });
  });

  // Reset a source's metrics to connector defaults
  app.delete("/api/sources/:name/metrics", async (req, res) => {
    const name = req.params.name;
    const sourceIdx = config.sources.findIndex((s) => s.name === name);
    if (sourceIdx === -1) {
      res.status(404).json({ error: `Source "${name}" not found` });
      return;
    }
    delete config.sources[sourceIdx].metrics;
    await registry.updateSource(name, config.sources[sourceIdx]);
    saveConfig(config);
    res.json({ ok: true });
  });

  // MCP Streamable HTTP transport — stateful sessions
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const sessionLastActive = new Map<string, number>();
  const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min idle timeout

  // Clean up idle sessions every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [sid, lastActive] of sessionLastActive) {
      if (now - lastActive > SESSION_TTL_MS) {
        transports.delete(sid);
        sessionLastActive.delete(sid);
        console.log(`Session ${sid} expired (idle)`);
      }
    }
  }, 5 * 60 * 1000);

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        // Clean up session on close
        for (const [sid, t] of transports) {
          if (t === transport) { transports.delete(sid); break; }
        }
      };

      await mcpServer.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);

    // Store session after handling (sessionId is set during handleRequest)
    const sid = res.getHeader("mcp-session-id") as string;
    if (sid) {
      if (!transports.has(sid)) transports.set(sid, transport);
      sessionLastActive.set(sid, Date.now());
    }
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: "No active session" });
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    const transport = transports.get(sessionId);
    if (transport) {
      await transport.handleRequest(req, res);
      transports.delete(sessionId);
      sessionLastActive.delete(sessionId);
    } else {
      res.status(400).json({ error: "No active session" });
    }
  });

  const PORT = parseInt(process.env.PORT || "3000");
  app.listen(PORT, () => {
    console.log(`observability-mcp server running on port ${PORT}`);
    console.log(`  MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log(`  Web UI: http://localhost:${PORT}`);
    console.log(`  Connectors: ${registry.getAll().map((c) => c.name).join(", ")}`);
  });
}

main().catch(console.error);
