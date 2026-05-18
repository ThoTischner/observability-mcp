#!/usr/bin/env node
import express from "express";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, saveConfig, DEFAULT_HEALTH_THRESHOLDS, DEFAULT_SETTINGS } from "./config/loader.js";
import { ConnectorRegistry, getSupportedTypes } from "./connectors/registry.js";
import { defaultContext, principalContext, type RequestContext } from "./context.js";
import {
  enforceEntitledAccess,
  enterpriseGateStatus,
  enterpriseGateInfo,
  enterprisePolicyView,
  enterpriseCatalogView,
  enterpriseAuditTail,
  authorizeAdmin,
  updateRbacPolicy,
} from "./enterprise-gate.js";
import {
  loadCredentials,
  credentialsConfigured,
  extractToken,
  resolveToken,
} from "./auth/credentials.js";
import { getPluginLoader } from "./connectors/loader.js";
import {
  resolveHubCatalogUrl,
  describeInstalled,
  mergeCatalog,
  fetchHubCatalog,
} from "./connectors/hub.js";
import { isValidConnectorName, installTarball } from "./connectors/install.js";
import { PluginVerificationError } from "./connectors/verify.js";
import { selfRegistry, withToolMetrics, apiRequests, mcpActiveSessions } from "./metrics/self.js";
import { buildOpenApiSpec } from "./openapi.js";
import { listSourcesHandler } from "./tools/list-sources.js";
import { listServicesHandler } from "./tools/list-services.js";
import { queryMetricsHandler } from "./tools/query-metrics.js";
import { queryLogsHandler } from "./tools/query-logs.js";
import { getServiceHealthHandler, setHealthThresholds } from "./tools/get-service-health.js";
import { detectAnomaliesHandler } from "./tools/detect-anomalies.js";
import type { Config } from "./types.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read once at startup; the file is shipped inside the image so this
// is the source of truth even when the user runs from `npx`.
const SERVER_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

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

// Hard cap for a downloaded/uploaded connector tarball (defence against
// a hostile or accidental huge artifact OOM-ing the server).
const MAX_CONNECTOR_TGZ_BYTES = 64 * 1024 * 1024;

// Per-client rate limiter for the expensive runtime routes (connector
// install/upload: fetch + extract + verify + fs write + loader rescan;
// add/test source: outbound backend connect). Uses express-rate-limit
// so the control is explicit and well-tested. Bounds abuse even with
// ENABLE_UI_INSTALL on.
const installRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate limit exceeded — too many attempts, slow down" },
});

async function main() {
  // Stdio transport mode (MCP catalogs / desktop clients / Glama's
  // mcp-proxy spawn a stdio MCP server and read JSON-RPC from stdout).
  // The protocol stream MUST be the only thing on stdout, so route all
  // console.log to stderr before anything logs.
  const STDIO =
    process.argv.includes("--stdio") ||
    process.env.MCP_TRANSPORT === "stdio" ||
    !!process.env.MCP_STDIO;
  if (STDIO) {
    console.log = (...a: unknown[]) => console.error(...a);
  }

  let config = loadConfig();
  await getPluginLoader().load();
  const registry = new ConnectorRegistry();
  await registry.initialize(config);
  applyConfigToRuntime(config, registry);

  // The MCP SDK Protocol class permits exactly one transport per instance,
  // so we cannot share a single McpServer across HTTP sessions. Each new
  // session needs its own server. The factory captures the live registry
  // by reference so tool handlers always see the current configuration.
  function createMcpServer(ctx: RequestContext): McpServer {
    const mcpServer = new McpServer({
      name: "observability-mcp",
      version: SERVER_VERSION,
    });

  // --- Register tools with Zod schemas ---

  mcpServer.tool(
    "list_sources",
    [
      "List the configured observability backends (Prometheus, Loki, and any connector) and whether each is currently reachable.",
      "When to use: call this first to learn which source names exist and are healthy before passing `source` to other tools, or to debug why a query returns no data.",
      "Behavior: read-only, no side effects. Returns one entry per source with its name, type, configured URL, signal types (metrics/logs), and a live up/down status. Never throws for an unreachable backend — the backend is reported as down instead.",
      "Related: use `list_services` to see what is monitored within these sources.",
    ].join(" "),
    {},
    async () => {
      await enforceEntitledAccess(ctx, { tool: "list_sources" });
      return withToolMetrics("list_sources", () => listSourcesHandler(registry, ctx));
    }
  );

  mcpServer.tool(
    "list_services",
    [
      "Discover the service names that can be queried, aggregated across every connected backend.",
      "When to use: call this before `query_metrics`, `query_logs`, or `get_service_health` to obtain the exact, case-sensitive service name those tools require.",
      "Behavior: read-only, no side effects. Returns one entry per service with the service name, the source(s) it was discovered in, and which signals are available for it (metrics, logs, or both).",
      "Related: `list_sources` for backend health; `get_service_health` for a per-service overview.",
    ].join(" "),
    {
      filter: z
        .string()
        .optional()
        .describe(
          "Optional case-insensitive substring to narrow the result to matching service names (e.g. 'payment'). Omit to list every discovered service.",
        ),
    },
    async (args) => {
      await enforceEntitledAccess(ctx, { tool: "list_services" });
      return withToolMetrics("list_services", () => listServicesHandler(registry, args, ctx));
    }
  );

  const metricsList = getAvailableMetricNames(registry);
  const metricNames = registry.getBySignal("metrics").flatMap(c => c.getMetrics().map(m => m.name));
  const uniqueNames = [...new Set(metricNames)];

  mcpServer.tool(
    "query_metrics",
    [
      "Fetch the raw time-series for ONE metric of ONE service over a look-back window, returned together with pre-computed summary statistics.",
      "When to use: when you need the actual numeric values or the trend of a known metric. For a 'is this service OK?' verdict use `get_service_health`; to find which services are misbehaving use `detect_anomalies`.",
      "Prerequisites: get the exact service name from `list_services` and choose a metric from the list at the end of this description.",
      "Behavior: read-only, no side effects. Returns an ordered array of {timestamp, value} points plus a summary {current, average, min, max, trend}. With `groupBy` set, returns one labelled series per distinct label value under `groups` instead of a single aggregated series. Units depend on the metric (e.g. CPU as %, latency as ms, rates as per-second). An unknown service/metric or an unreachable backend yields a structured explanatory error, never an exception.",
      `Available metrics: ${metricsList}`,
    ].join(" "),
    {
      service: z
        .string()
        .describe(
          "Required. Exact, case-sensitive service name exactly as returned by `list_services` (e.g. 'api-gateway', 'payment-service').",
        ),
      metric: z
        .string()
        .describe(
          `Required. Exact metric name to query. One of: ${uniqueNames.join(", ")}.`,
        ),
      duration: z
        .string()
        .optional()
        .describe(
          "Optional. Look-back window ending at 'now', written as <number><unit> with unit s|m|h|d (e.g. '5m', '90m', '1h', '24h'). Default: '5m'.",
        ),
      source: z
        .string()
        .optional()
        .describe(
          "Optional. Restrict the query to a single backend by its source name (see `list_sources`). Default: query and merge all metrics backends.",
        ),
      groupBy: z
        .string()
        .optional()
        .describe(
          "Optional. Metric label to break the result down by, e.g. 'instance', 'pod', 'node'. When set, the response contains one series per distinct label value under `groups`. Default: a single aggregated series.",
        ),
    },
    async (args) => {
      await enforceEntitledAccess(ctx, { tool: "query_metrics", source: (args as any)?.source, service: (args as any)?.service });
      return withToolMetrics("query_metrics", () => queryMetricsHandler(registry, args, ctx));
    }
  );

  mcpServer.tool(
    "query_logs",
    [
      "Fetch recent log entries for ONE service over a look-back window, with a pre-computed summary (error/warning counts and the most frequent error patterns).",
      "When to use: to inspect what a service actually logged, or to investigate an error spike surfaced by `detect_anomalies` / `get_service_health`. For numeric metrics use `query_metrics` instead.",
      "Prerequisites: get the exact service name from `list_services` (the service must expose a logs signal).",
      "Behavior: read-only, no side effects. Returns the matching log entries (newest first, capped by `limit`) plus a summary with total/error/warn counts and top recurring error patterns. No matches yields an empty result with a zeroed summary; an unreachable backend yields a structured explanatory error, never an exception.",
    ].join(" "),
    {
      service: z
        .string()
        .describe(
          "Required. Exact, case-sensitive service name exactly as returned by `list_services` (e.g. 'payment-service').",
        ),
      query: z
        .string()
        .optional()
        .describe(
          "Optional. Filter expression matched against the log message; regular expressions are supported. Omit to return all entries in the window.",
        ),
      duration: z
        .string()
        .optional()
        .describe(
          "Optional. Look-back window ending at 'now', written as <number><unit> with unit s|m|h|d (e.g. '5m', '1h', '24h'). Default: '5m'.",
        ),
      level: z
        .enum(["error", "warn", "info", "debug"])
        .optional()
        .describe(
          "Optional. Return only entries at this severity. Default: all levels.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Optional. Maximum number of log entries to return (most recent first). Default: 100.",
        ),
    },
    async (args) => {
      await enforceEntitledAccess(ctx, { tool: "query_logs", source: (args as any)?.source, service: (args as any)?.service });
      return withToolMetrics("query_logs", () => queryLogsHandler(registry, args, ctx));
    }
  );

  mcpServer.tool(
    "get_service_health",
    [
      "Produce a single aggregated health verdict for ONE service by combining its metrics and logs.",
      "When to use: the fastest way to answer 'is this service healthy right now and why?'. Use `query_metrics`/`query_logs` to drill into the underlying numbers, or `detect_anomalies` to scan many services at once.",
      "Prerequisites: get the exact service name from `list_services`.",
      "Behavior: read-only, no side effects. Returns a weighted health score (0–100), a status of healthy | degraded | critical, the key contributing metrics, a log error summary, detected anomalies, and cross-signal correlations explaining the score. A service with no data yields an explanatory result rather than an exception.",
    ].join(" "),
    {
      service: z
        .string()
        .describe(
          "Required. Exact, case-sensitive service name exactly as returned by `list_services` (e.g. 'payment-service').",
        ),
    },
    async (args) => {
      await enforceEntitledAccess(ctx, { tool: "get_service_health", service: (args as any)?.service });
      return withToolMetrics("get_service_health", () => getServiceHealthHandler(registry, args, ctx));
    }
  );

  mcpServer.tool(
    "detect_anomalies",
    [
      "Scan one or all monitored services for abnormal behavior and return the findings ranked by severity.",
      "When to use: the entry point for 'is anything wrong anywhere?' triage. Once a service is flagged, follow up with `get_service_health` for the verdict or `query_metrics`/`query_logs` for the raw evidence.",
      "Behavior: read-only, no side effects. Applies z-score analysis to metrics, detects log error-rate spikes, and correlates the two. Returns a list of anomalies, each with the affected service, metric/signal, severity, the deviation (e.g. σ and % change), and a short explanation. No anomalies yields an empty list, not an error.",
      "Related: `get_service_health` (single-service verdict), `query_metrics` (raw series behind a flagged metric).",
    ].join(" "),
    {
      service: z
        .string()
        .optional()
        .describe(
          "Optional. Restrict the scan to one service (exact, case-sensitive name from `list_services`). Default: scan every monitored service.",
        ),
      duration: z
        .string()
        .optional()
        .describe(
          "Optional. Look-back window analyzed for anomalies, written as <number><unit> with unit s|m|h|d (e.g. '5m', '15m', '1h'). Default: '10m'.",
        ),
      sensitivity: z
        .enum(["low", "medium", "high"])
        .optional()
        .describe(
          "Optional. Detection threshold: 'low' flags only strong deviations (>3σ), 'medium' is balanced (>2σ), 'high' is most sensitive and noisier (>1.5σ). Default: 'medium'.",
        ),
    },
    async (args) => {
      await enforceEntitledAccess(ctx, { tool: "detect_anomalies", source: (args as any)?.source, service: (args as any)?.service });
      return withToolMetrics("detect_anomalies", () => detectAnomaliesHandler(registry, args, ctx));
    }
  );

    return mcpServer;
  }

  // --- HTTP server ---
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Security headers
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    // Dynamic API responses must never be served from the browser/proxy
    // cache: after a mutation (e.g. installing a connector) the UI
    // re-fetches these GETs immediately, and a heuristically-cached stale
    // body would make the change "not show up until a page reload".
    if (req.path.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store");
    }
    next();
  });

  // API request counter — emitted at response time so the `status` label
  // is the real outcome. /metrics itself is excluded to avoid self-scrape
  // amplification.
  app.use((req, res, next) => {
    if (req.path === "/metrics") return next();
    res.on("finish", () => {
      // Group dynamic segments by the registered Express route when we
      // have one, otherwise fall back to the literal path. This keeps
      // label cardinality bounded.
      const route =
        (req as unknown as { route?: { path?: string } }).route?.path ?? req.path;
      apiRequests.inc({ route, method: req.method, status: String(res.statusCode) });
    });
    next();
  });

  // k8s-convention liveness/readiness probes at the root of the path
  // tree, no /api prefix. Helm chart points its probes here. Cheap
  // enough to skip the request-counter middleware.
  let ready = false;
  app.get("/healthz", (_req, res) => res.type("text").send("ok"));
  app.get("/readyz", (_req, res) => {
    if (ready) return res.type("text").send("ok");
    return res.status(503).type("text").send("starting");
  });

  // OpenAPI 3.1 document for the /api/* surface.
  app.get("/api/openapi.json", (_req, res) => {
    res.json(buildOpenApiSpec(SERVER_VERSION));
  });

  // Self-monitoring — Prometheus scrape endpoint.
  // Disabled with METRICS_ENABLED=false for environments that prefer
  // sidecar agents. The Helm chart's ServiceMonitor template targets
  // this endpoint when enabled.
  if (process.env.METRICS_ENABLED !== "false") {
    app.get("/metrics", async (_req, res) => {
      res.set("Content-Type", selfRegistry.contentType);
      res.end(await selfRegistry.metrics());
    });
  }

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

  // Server info — version, loaded plugins, MCP protocol version, build metadata.
  // Used by the Web UI footer and by operators to confirm what's deployed.
  app.get("/api/info", async (_req, res) => {
    const loader = getPluginLoader();
    res.json({
      name: "observability-mcp",
      version: SERVER_VERSION,
      enterpriseGate: await enterpriseGateStatus(),
      mcpProtocolVersion: "2025-03-26",
      build: {
        commit: process.env.GIT_COMMIT || null,
        date: process.env.BUILD_DATE || null,
      },
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      plugins: loader.list().map((p) => ({
        name: p.name,
        source: p.source,
        version: p.manifest?.version ?? null,
        signalTypes: p.manifest?.signalTypes ?? null,
      })),
    });
  });

  // Connectors currently loaded into this server (builtin + filesystem
  // plugins), with manifest metadata — drives the UI "Connectors" page.
  app.get("/api/connectors", (_req, res) => {
    res.json({ connectors: describeInstalled(getPluginLoader().list()) });
  });

  // --- Enterprise console (read-only introspection) -------------------
  // Drives the management UI's Enterprise page. Read-only in this phase;
  // never exposes the entitlement token or any key. Same trusted-local
  // management plane as the other /api/* endpoints (see auth-and-tls).
  app.get("/api/enterprise/status", async (_req, res) => {
    try {
      res.json(await enterpriseGateInfo());
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });
  app.get("/api/enterprise/policy", (_req, res) => {
    res.json(enterprisePolicyView());
  });
  app.get("/api/enterprise/catalog", (_req, res) => {
    res.json(enterpriseCatalogView());
  });
  app.get("/api/enterprise/audit", async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    try {
      res.json(await enterpriseAuditTail(limit));
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });
  // Phase 2: edit the RBAC policy. NOT on the open local plane — requires
  // an API-key principal the CURRENT policy grants `enterprise:admin`.
  app.put("/api/enterprise/policy", async (req, res) => {
    const cred = resolveToken(
      extractToken(req.headers as Record<string, unknown>),
      loadCredentials()
    );
    const principal = cred ? cred.name : null;
    const authz = await authorizeAdmin(principal);
    if (!authz.ok) return res.status(authz.status).json({ error: authz.error });
    const result = await updateRbacPolicy(principal as string, req.body);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
  });

  // Server-side proxy of the connector hub catalog (so the browser
  // needn't reach the hub directly — works behind a proxy / against a
  // mirror via HUB_CATALOG_URL). Installed status merged in.
  app.get("/api/hub/catalog", async (_req, res) => {
    const url = resolveHubCatalogUrl();
    try {
      const catalog = await fetchHubCatalog(url);
      res.json({
        url,
        connectors: mergeCatalog(catalog, describeInstalled(getPluginLoader().list())),
      });
    } catch (e) {
      res.status(502).json({ url, error: e instanceof Error ? e.message : String(e), connectors: [] });
    }
  });

  // Install a connector from the hub into the running server.
  //
  // Runtime code-load is powerful, so this is doubly gated:
  //   1. ENABLE_UI_INSTALL=true must be set (default OFF).
  //   2. PLUGIN_TRUST_ROOT must be configured — install is ALWAYS
  //      fail-closed verified (no insecure bypass over HTTP).
  // Only catalog tarballUrls are fetched (no arbitrary URL in the body)
  // to avoid SSRF. The connector persists to PLUGINS_DIR (back it with
  // a PVC on k8s so it survives restarts).
  app.post("/api/connectors/install", installRateLimit, async (req, res) => {
    if (process.env.ENABLE_UI_INSTALL !== "true") {
      return res.status(403).json({
        error: "UI install is disabled. Set ENABLE_UI_INSTALL=true and PLUGIN_TRUST_ROOT to enable it.",
      });
    }
    const trustRootPath = process.env.PLUGIN_TRUST_ROOT;
    if (!trustRootPath) {
      return res.status(412).json({
        error: "PLUGIN_TRUST_ROOT not configured — refusing to install unverified code.",
      });
    }
    const name = (req.body || {}).name;
    const version = (req.body || {}).version as string | undefined;
    if (!isValidConnectorName(name)) {
      return res.status(400).json({ error: "invalid connector name" });
    }
    const pluginsDir = process.env.PLUGINS_DIR ?? "/app/plugins";
    let work: string | null = null;
    try {
      const catalog = await fetchHubCatalog(resolveHubCatalogUrl());
      const entry = catalog.connectors.find((c) => c.name === name);
      if (!entry) return res.status(404).json({ error: `'${name}' is not in the catalog` });
      if (entry.builtin) return res.status(409).json({ error: `'${name}' is builtin — no install needed` });
      const v = version
        ? entry.versions.find((x) => x.version === version)
        : entry.versions.find((x) => x.version === (entry.latest ?? entry.versions[0]?.version)) ?? entry.versions[0];
      if (!v || !v.tarballUrl) {
        return res.status(422).json({ error: `no tarball for ${name}@${version ?? "latest"}` });
      }
      const resp = await fetch(v.tarballUrl);
      if (!resp.ok) return res.status(502).json({ error: `tarball download HTTP ${resp.status}` });
      const declared = Number(resp.headers.get("content-length") || 0);
      if (declared > MAX_CONNECTOR_TGZ_BYTES) {
        return res.status(413).json({ error: `tarball too large (${declared} bytes)` });
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > MAX_CONNECTOR_TGZ_BYTES) {
        return res.status(413).json({ error: `tarball too large (${buf.length} bytes)` });
      }
      work = mkdtempSync(join(tmpdir(), "obsmcp-dl-"));
      const tgz = join(work, "c.tgz");
      writeFileSync(tgz, buf);
      const result = installTarball({ tgzPath: tgz, pluginsDir, trustRootPath, expectedName: name });
      await getPluginLoader().load(); // re-scan so /api/connectors reflects it
      res.json({
        ok: true,
        ...result,
        note: "installed & persisted to PLUGINS_DIR. Add a source of this type to use it; a server restart is recommended for full availability in existing MCP sessions.",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = e instanceof PluginVerificationError ? 400 : 500;
      res.status(code).json({ error: `install failed (fail-closed): ${msg}` });
    } finally {
      if (work) rmSync(work, { recursive: true, force: true });
    }
  });

  // Upload a connector bundle (.tgz) and install it into the running
  // server. Same fail-closed guardrails as /install: the upload is
  // ALWAYS verified against PLUGIN_TRUST_ROOT (signature + integrity),
  // so an unsigned/tampered bundle is rejected. Body is the raw tarball
  // bytes (application/octet-stream). Persists to PLUGINS_DIR.
  app.post(
    "/api/connectors/upload",
    installRateLimit,
    express.raw({ type: "application/octet-stream", limit: "50mb" }),
    async (req, res) => {
      if (process.env.ENABLE_UI_INSTALL !== "true") {
        return res.status(403).json({
          error: "UI install is disabled. Set ENABLE_UI_INSTALL=true and PLUGIN_TRUST_ROOT to enable it.",
        });
      }
      const trustRootPath = process.env.PLUGIN_TRUST_ROOT;
      if (!trustRootPath) {
        return res.status(412).json({
          error: "PLUGIN_TRUST_ROOT not configured — refusing to install unverified code.",
        });
      }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return res.status(400).json({ error: "empty body — POST the connector .tgz as application/octet-stream" });
      }
      const pluginsDir = process.env.PLUGINS_DIR ?? "/app/plugins";
      let work: string | null = null;
      try {
        work = mkdtempSync(join(tmpdir(), "obsmcp-up-"));
        const tgz = join(work, "c.tgz");
        writeFileSync(tgz, body);
        const result = installTarball({ tgzPath: tgz, pluginsDir, trustRootPath });
        await getPluginLoader().load(); // re-scan so /api/connectors reflects it
        res.json({
          ok: true,
          ...result,
          note: "uploaded, verified & persisted to PLUGINS_DIR. Add a source of this type to use it; a server restart is recommended for full availability in existing MCP sessions.",
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const code = e instanceof PluginVerificationError ? 400 : 500;
        res.status(code).json({ error: `upload install failed (fail-closed): ${msg}` });
      } finally {
        if (work) rmSync(work, { recursive: true, force: true });
      }
    },
  );

  // Add a new source
  app.post("/api/sources", installRateLimit, async (req, res) => {
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
  app.post("/api/sources/test", installRateLimit, async (req, res) => {
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
      const result = await listServicesHandler(registry, {}, defaultContext());
      res.json(parseToolResult(result));
    } catch { res.status(500).json({ error: "Failed to list services" }); }
  });

  // Health endpoint for UI dashboard
  app.get("/api/health/:service", async (req, res) => {
    try {
      const result = await getServiceHealthHandler(registry, { service: req.params.service }, defaultContext());
      res.json(parseToolResult(result));
    } catch {
      res.status(500).json({ error: "Failed to get service health" });
    }
  });

  // Health for all services
  app.get("/api/health", async (_req, res) => {
    try {
      const servicesResult = await listServicesHandler(registry, {}, defaultContext());
      const parsed = parseToolResult(servicesResult) as { services?: Array<{ name: string }> };
      const services = parsed?.services || [];
      const health: Record<string, unknown> = {};
      for (const svc of services) {
        try {
          const result = await getServiceHealthHandler(registry, { service: svc.name }, defaultContext());
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

  // Stdio transport: one server over stdin/stdout, no HTTP listener.
  if (STDIO) {
    const server = createMcpServer(defaultContext());
    await server.connect(new StdioServerTransport());
    console.error(
      `observability-mcp running on stdio transport · connectors: ${registry
        .getAll()
        .map((c) => c.name)
        .join(", ")}`
    );
    return;
  }

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
    mcpActiveSessions.set(transports.size);
  }, 5 * 60 * 1000);

  // Single-tenant auth gate. No credentials configured → anonymous (current
  // behaviour, fully backward compatible). Configured → require a valid
  // Bearer/X-API-Key on every /mcp request; resolve the principal + its
  // coarse source allow-list into the RequestContext.
  function gateCtx(
    req: import("express").Request,
    res: import("express").Response
  ): RequestContext | null {
    if (!credentialsConfigured()) return defaultContext();
    const cred = resolveToken(
      extractToken(req.headers as Record<string, unknown>),
      loadCredentials()
    );
    if (!cred) {
      res
        .status(401)
        .json({ error: "unauthorized: valid Bearer token or X-API-Key required" });
      return null;
    }
    return principalContext(cred.name, cred.allowedSources);
  }

  app.post("/mcp", async (req, res) => {
    const ctx = gateCtx(req, res);
    if (!ctx) return;
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
        mcpActiveSessions.set(transports.size);
      };

      const sessionMcpServer = createMcpServer(ctx);
      await sessionMcpServer.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);

    // Store session after handling (sessionId is set during handleRequest)
    const sid = res.getHeader("mcp-session-id") as string;
    if (sid) {
      if (!transports.has(sid)) transports.set(sid, transport);
      sessionLastActive.set(sid, Date.now());
    }
    mcpActiveSessions.set(transports.size);
  });

  app.get("/mcp", async (req, res) => {
    if (!gateCtx(req, res)) return;
    const sessionId = req.headers["mcp-session-id"] as string;
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: "No active session" });
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    if (!gateCtx(req, res)) return;
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
    ready = true;
    console.log(`observability-mcp server running on port ${PORT}`);
    console.log(`  MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log(`  Web UI: http://localhost:${PORT}`);
    console.log(`  Connectors: ${registry.getAll().map((c) => c.name).join(", ")}`);
  });
}

main().catch(console.error);
