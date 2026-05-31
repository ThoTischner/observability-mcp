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
import { isTopologyProvider } from "./connectors/interface.js";
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
  updateCatalog,
} from "./enterprise-gate.js";
import {
  loadCredentials,
  credentialsConfigured,
  extractToken,
  resolveToken,
} from "./auth/credentials.js";
import {
  issueSession,
  setCookieHeader,
  clearCookieHeader,
  generateSecret,
  type SessionConfig,
} from "./auth/session.js";
import {
  readUsersFile,
  authenticate,
  type LocalUsersFile,
} from "./auth/local-users.js";
import {
  buildSessionAttacher,
  buildRequireSession,
  type AuthMode,
  type AuthRuntime,
  type AuthedRequest,
} from "./auth/middleware.js";
import {
  buildRequirePermission,
  listGrantedPermissions,
  DEFAULT_POLICY,
  type Resource,
  type Action,
} from "./auth/rbac.js";
import { resolveOidcConfig, buildOidcRuntime } from "./auth/oidc/runtime.js";
import { AuditLog } from "./audit/log.js";
import { buildAuditMiddleware } from "./audit/middleware.js";
import { readCatalogFile, CatalogStore } from "./catalog/loader.js";
import { redactValue } from "./policy/redact.js";
import { IdentityRateLimiter, resolveToolRatePerMin } from "./quota/limiter.js";
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
import { getTopologyHandler, getBlastRadiusHandler } from "./tools/topology.js";
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

/** Defensive read of a single query-string value. Express's
 * `req.query[k]` is typed as `string | ParsedQs | (string | ParsedQs)[]`
 * — a caller passing `?actor=a&actor=b` (or `?actor[]=a`) yields an
 * array (or object) rather than a string, which then propagates as
 * `[a,b]` into downstream filters that expect a string. This helper
 * returns the first string-shaped value or undefined; arrays / nested
 * objects collapse safely instead of leaking through. */
function qstr(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

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
  // Catalog enrichers for the MCP tool surface: wrap the standard
  // tool-result shape ({content:[{text: json}]}) and inject .catalog
  // metadata where it matches a known service name. No-op when the
  // catalog is empty (the demo case) or when the payload doesn't
  // parse as JSON. The HTTP `/api/services` + `/api/health` handlers
  // call the loader.ts CatalogStore directly; this path mirrors that
  // behaviour for MCP clients (Claude Desktop, the agent, ...).
  // McpToolResult is whatever the wrapped handler returned — keep it
  // untyped so we don't fight the SDK's narrow `content: [{type:"text",...}]`
  // overload. We pass the value back unchanged when it doesn't parse,
  // and otherwise mutate the parsed JSON before re-stringifying into a
  // fresh wrapper that mirrors the handler's own shape.
  function enrichToolServicesText<T extends { content: Array<{ text: string }> }>(result: T): T {
    try {
      const parsed = JSON.parse(result.content[0]?.text ?? "{}");
      if (parsed && Array.isArray(parsed.services)) {
        for (const s of parsed.services) {
          const entry = typeof s?.name === "string" ? catalog.get(s.name) : undefined;
          if (entry) s.catalog = entry;
        }
      }
      const clone = { ...result, content: result.content.map((c, i) => i === 0 ? { ...c, text: JSON.stringify(parsed) } : c) };
      return clone as T;
    } catch {
      return result;
    }
  }
  // Apply PII / secret redaction to a tool result's text payload. No-op
  // when OMCP_REDACTION=off. Adds a top-level `_redacted` field with
  // the per-category counts so the agent (and the human) sees a hint
  // like `{ email: 4, ipv4: 2, totalMatches: 6 }` instead of silently
  // losing data.
  const REDACTION_ENABLED = String(process.env.OMCP_REDACTION ?? "on").toLowerCase() !== "off";
  function redactToolText<T extends { content: Array<{ text: string }> }>(result: T): T {
    if (!REDACTION_ENABLED) return result;
    try {
      const parsed = JSON.parse(result.content[0]?.text ?? "{}");
      const r = redactValue(parsed);
      const redacted = r.value as Record<string, unknown>;
      if (r.totalMatches > 0 && redacted && typeof redacted === "object") {
        redacted._redacted = { ...r.matches, totalMatches: r.totalMatches };
      }
      const clone = { ...result, content: result.content.map((c, i) => i === 0 ? { ...c, text: JSON.stringify(redacted) } : c) };
      return clone as T;
    } catch {
      return result;
    }
  }

  function enrichToolHealthText<T extends { content: Array<{ text: string }> }>(result: T, serviceName: string): T {
    try {
      const parsed = JSON.parse(result.content[0]?.text ?? "{}");
      const entry = serviceName ? catalog.get(serviceName) : undefined;
      if (entry && parsed && typeof parsed === "object") parsed.catalog = entry;
      const clone = { ...result, content: result.content.map((c, i) => i === 0 ? { ...c, text: JSON.stringify(parsed) } : c) };
      return clone as T;
    } catch {
      return result;
    }
  }

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
      const result = await withToolMetrics("list_services", () => listServicesHandler(registry, args, ctx));
      return enrichToolServicesText(result);
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
      const result = await withToolMetrics("query_logs", () => queryLogsHandler(registry, args, ctx));
      // Redact PII / secrets from the log payload before it crosses the
      // MCP boundary into the agent's context. Opt-out at deploy time
      // with OMCP_REDACTION=off — useful when the operator already
      // pre-scrubs at ingest and over-redaction would hurt debugging.
      return redactToolText(result);
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
      const result = await withToolMetrics("get_service_health", () => getServiceHealthHandler(registry, args, ctx));
      return enrichToolHealthText(result, String((args as any)?.service ?? ""));
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

  mcpServer.tool(
    "get_topology",
    [
      "Return the infrastructure topology graph (Resources and Edges) from every topology-capable connector.",
      "When to use: when an agent needs to reason about which workload runs on which host, who owns whom, or which scope (namespace/project/folder) a resource belongs to. Pair with `get_blast_radius` for shared-host RCA.",
      "Behavior: read-only, no side effects. Returns `{ sources, resources, edges, total, truncated }`. Filters compose: `source` to one connector, `kind` to one resource type (e.g. 'pod', 'node', 'deployment'), `scope` to members of a namespace/folder/project. Output is capped by `limit` (default 500, max 5000) and edges referencing dropped resources are removed.",
      "Related: `get_blast_radius` to evaluate the impact of a host failure; `list_sources` to discover topology-capable connectors.",
    ].join(" "),
    {
      source: z
        .string()
        .optional()
        .describe(
          "Optional. Restrict the graph to one topology connector by source name (see `list_sources`). Default: merge across all connectors.",
        ),
      kind: z
        .string()
        .optional()
        .describe(
          "Optional. Restrict to resources of one kind. Common values for Kubernetes: 'pod', 'node', 'deployment', 'replicaset', 'namespace'. Other connectors may emit different kinds (e.g. 'vm', 'hypervisor', 'volume'). Default: all kinds.",
        ),
      scope: z
        .string()
        .optional()
        .describe(
          "Optional. Restrict to resources contained in a scope (anything pointed to by `IN_NAMESPACE` edges). Pass the scope's resource id (e.g. 'k8s:namespace:default') or its name (e.g. 'default'). Default: no scope filter.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe(
          "Optional. Maximum resources to return; edges are trimmed to the kept set. Default 500, max 5000.",
        ),
    },
    async (args) => {
      await enforceEntitledAccess(ctx, { tool: "get_topology", source: (args as any)?.source });
      return withToolMetrics("get_topology", () => getTopologyHandler(registry, args, ctx));
    }
  );

  mcpServer.tool(
    "get_blast_radius",
    [
      "Given a resource, return who else fails if its underlying host(s) fail.",
      "When to use: cross-cutting RCA — when several services degrade together and you suspect a shared host. Works for any RUNS_ON relationship: pod→node, vm→hypervisor, container→host.",
      "Behavior: read-only, no side effects. Resolves `resource` to a Resource (accepts canonical id, exact name, or unique substring), determines its host(s) via RUNS_ON, then lists every other resource that runs on those hosts, bucketed by ownership root (the terminal `OWNED_BY` target — e.g. the Deployment, not the ReplicaSet). If the target is itself a host, its tenants are reported. Returns a structured error if the resource is ambiguous or unknown.",
      "Related: `get_topology` for the full graph; `get_service_health` for the per-service verdict on each co-tenant.",
    ].join(" "),
    {
      resource: z
        .string()
        .describe(
          "Required. Resource to evaluate. Accepts the canonical id (e.g. 'k8s:pod:default/checkout-7f89d'), the exact resource name (e.g. 'checkout-7f89d'), or a unique substring of either.",
        ),
    },
    async (args) => {
      await enforceEntitledAccess(ctx, { tool: "get_blast_radius" });
      return withToolMetrics("get_blast_radius", () => getBlastRadiusHandler(registry, args, ctx));
    }
  );

    return mcpServer;
  }

  // --- Management-plane auth (basic mode) -----------------------------------
  // Off by default. Enable with `OMCP_AUTH=basic` + `OMCP_USERS_FILE` and
  // optionally `OMCP_SESSION_SECRET`. When the secret is omitted in basic
  // mode the server generates one for the process lifetime — sessions
  // won't survive a restart and a warning is logged. See docs/auth-basic.md.
  //
  // SECURITY DEFAULT: misconfiguration in basic mode is fail-CLOSED — the
  // process exits with a non-zero status rather than silently degrading
  // to anonymous. Set `OMCP_AUTH_ALLOW_FALLBACK=true` to opt back into
  // the old fall-back-to-anonymous behaviour (only sensible for the
  // throwaway-demo case where ops can immediately see the boot log).
  const requestedAuthMode = String(process.env.OMCP_AUTH ?? "anonymous").toLowerCase();
  const allowFallback = String(process.env.OMCP_AUTH_ALLOW_FALLBACK ?? "false").toLowerCase() === "true";
  function authMisconfig(reason: string): never | void {
    if (allowFallback) {
      console.error(`[auth] ${reason} — OMCP_AUTH_ALLOW_FALLBACK=true → falling back to anonymous`);
      return;
    }
    console.error(`[auth] ${reason} — refusing to start (set OMCP_AUTH_ALLOW_FALLBACK=true to override)`);
    process.exit(1);
  }
  let authMode: AuthMode = "anonymous";
  let sessionCfg: SessionConfig | undefined;
  let usersStore: LocalUsersFile | null = null;
  let secretEphemeral = false;
  let oidcRuntime: ReturnType<typeof buildOidcRuntime> | undefined;
  if (requestedAuthMode === "basic") {
    const usersPath = process.env.OMCP_USERS_FILE;
    if (!usersPath) {
      authMisconfig("OMCP_AUTH=basic requires OMCP_USERS_FILE");
    } else {
      usersStore = await readUsersFile(usersPath);
      if (!usersStore) {
        authMisconfig(`OMCP_USERS_FILE=${usersPath} unreadable or malformed`);
        usersStore = null;
      } else if (usersStore.users.length === 0) {
        authMisconfig(`OMCP_USERS_FILE=${usersPath} has no users`);
        usersStore = null;
      } else {
        let secret = process.env.OMCP_SESSION_SECRET;
        if (!secret || secret.length < 32) {
          secret = generateSecret();
          secretEphemeral = true;
          console.warn(
            "[auth] OMCP_SESSION_SECRET not set (or < 32 chars). Generated an ephemeral secret — " +
              "sessions will be invalidated on restart. Set OMCP_SESSION_SECRET to a stable value in production.",
          );
        }
        sessionCfg = { secret };
        authMode = "basic";
        console.log(`[auth] basic mode active — ${usersStore.users.length} user(s) loaded`);
      }
    }
  } else if (requestedAuthMode === "oidc") {
    const r = resolveOidcConfig(process.env);
    if (r.error || !r.config) {
      authMisconfig(r.error ?? "OIDC misconfigured");
    } else {
      let secret = process.env.OMCP_SESSION_SECRET;
      if (!secret || secret.length < 32) {
        secret = generateSecret();
        secretEphemeral = true;
        console.warn(
          "[auth] OMCP_SESSION_SECRET not set (or < 32 chars) in OIDC mode. " +
            "Generated an ephemeral secret — sessions and OIDC state cookies " +
            "will be invalidated on restart. Set OMCP_SESSION_SECRET in production.",
        );
      }
      sessionCfg = { secret };
      authMode = "oidc";
      oidcRuntime = buildOidcRuntime(r.config);
      console.log(`[auth] OIDC mode active — issuer=${r.config.issuer} clientId=${r.config.clientId} rolesClaim=${r.config.rolesClaim} mappedRoles=${Object.keys(r.config.roleMap).length}`);
    }
  } else if (requestedAuthMode !== "anonymous") {
    authMisconfig(`unknown OMCP_AUTH=${requestedAuthMode}`);
  }
  const authRuntime: AuthRuntime = { mode: authMode, session: sessionCfg, secretEphemeral, oidc: oidcRuntime };

  // --- HTTP server ---
  const app = express();

  // Trust-proxy: when set, Express will read req.ip / req.secure from
  // X-Forwarded-For + X-Forwarded-Proto. OFF by default — forging those
  // headers behind a misconfigured deployment is the kind of mistake
  // that gives every audit entry the same client IP. Set
  // `OMCP_TRUST_PROXY` to:
  //   "true"            — trust every hop (Express default-on shape)
  //   "loopback"        — trust 127.0.0.1 / ::1 only (sensible default
  //                       when running behind a same-host nginx)
  //   "<n>"             — trust the last <n> hops
  //   "<ip>,<ip>"       — explicit list (single value or comma-separated)
  // Any falsy / unset value leaves it OFF so req.ip stays the raw
  // socket address.
  const trustProxy = process.env.OMCP_TRUST_PROXY;
  if (trustProxy && trustProxy !== "false") {
    if (trustProxy === "true") {
      app.set("trust proxy", true);
    } else if (/^\d+$/.test(trustProxy)) {
      app.set("trust proxy", parseInt(trustProxy, 10));
    } else {
      // string or comma-separated IPs / "loopback" / etc — let Express's
      // parser handle the lookup (it accepts any of the above forms).
      app.set("trust proxy", trustProxy);
    }
  }

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

  // Broad rate-limit on the whole management-plane surface. Generous
  // enough to leave a polling UI plenty of headroom (300/min per IP),
  // tight enough to stop unauthenticated brute-force walks of /api/*
  // (and to keep CodeQL's missing-rate-limiting rule satisfied for
  // every downstream route).
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      max: 300,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "rate limited" },
    }),
  );

  // Management-plane auth: attach the session payload to every request
  // (no decision logic here — anonymous mode is a no-op). The gate is
  // mounted explicitly on each protected route prefix further down so
  // there is no string-match-based "is this public?" branch anywhere.
  app.use(buildSessionAttacher(authRuntime));
  const requireSession = buildRequireSession(authRuntime);
  const need = (resource: Resource, action: Action) =>
    buildRequirePermission(authRuntime, resource, action);

  // Management-plane audit log. Records one entry per mutating /api/*
  // request. Writes JSONL to disk when OMCP_MGMT_AUDIT_FILE is set;
  // otherwise an in-memory ring of the last 500 entries keeps the
  // /api/audit endpoint useful in the demo / single-user case.
  const mgmtAudit = new AuditLog({ file: process.env.OMCP_MGMT_AUDIT_FILE });
  await mgmtAudit.bootstrap();
  const audit = (resource: string, action: string) =>
    buildAuditMiddleware({ audit: mgmtAudit, resource, action });

  // Service catalog: optional operator-curated ownership / criticality /
  // on-call metadata, keyed on the service name list_services returns.
  // No file ⇒ empty catalog, enrichment is a no-op (anonymous demos
  // see no behaviour change).
  const catalog = new CatalogStore(await readCatalogFile(process.env.OMCP_SERVICE_CATALOG_FILE));
  // Protected route prefixes. /api/me, /api/auth/*, /api/info,
  // /api/openapi.json deliberately don't appear here — they stay public.
  for (const prefix of [
    "/api/sources",
    "/api/source-types",
    "/api/services",
    "/api/health",
    "/api/health-thresholds",
    "/api/topology",
    "/api/settings",
    "/api/connectors",
    "/api/enterprise",
    "/api/hub",
    "/api/audit",
    "/api/usage",
    "/api/catalog",
    "/api/policy",
  ]) {
    app.use(prefix, requireSession);
  }

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
      // Governance posture — surfaces the active management-plane
      // configuration so external dashboards / discovery probes don't
      // need a session to learn the deployment shape. Booleans only;
      // file paths and the session secret stay private.
      governance: {
        authMode: authRuntime.mode,
        authSecretEphemeral: !!authRuntime.secretEphemeral,
        // OIDC issuer (URL only — never the client_secret) is the
        // single piece of state external discovery needs to know
        // *where* the IdP lives. Empty string when mode != "oidc".
        oidcIssuer: oidcRuntime?.cfg.issuer ?? "",
        auditPersisted: !!process.env.OMCP_MGMT_AUDIT_FILE,
        catalogConfigured: catalog.count() > 0 || !!process.env.OMCP_SERVICE_CATALOG_FILE,
        redaction: REDACTION_ENABLED,
        trustProxy: !!(process.env.OMCP_TRUST_PROXY && process.env.OMCP_TRUST_PROXY !== "false"),
        toolRatePerMin: resolveToolRatePerMin(process.env.OMCP_TOOL_RATE_PER_MIN),
      },
      plugins: loader.list().map((p) => ({
        name: p.name,
        source: p.source,
        version: p.manifest?.version ?? null,
        signalTypes: p.manifest?.signalTypes ?? null,
      })),
    });
  });

  // Same per-IP cap for /api/me and the auth endpoints — the UI polls
  // this on every page load to decide whether to show the login modal,
  // so a 20/min limit per IP is generous for humans and tight for
  // scripted abuse.
  const authReadRateLimit = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "rate limited" },
  });

  // Current identity for the management plane. Always public so the UI
  // can decide whether to show a login modal even before sending its
  // first authenticated request.
  app.get("/api/me", authReadRateLimit, (req, res) => {
    if (authRuntime.mode === "anonymous") {
      res.json({ authenticated: false, mode: "anonymous" });
      return;
    }
    const sess = (req as AuthedRequest).session;
    if (!sess) {
      res.json({ authenticated: false, mode: authRuntime.mode });
      return;
    }
    res.json({
      authenticated: true,
      mode: authRuntime.mode,
      user: { sub: sess.sub, name: sess.name, roles: sess.roles ?? [] },
      permissions: listGrantedPermissions(sess.roles),
      exp: sess.exp,
    });
  });

  // --- /api/policy — read-only view of the RBAC policy in effect -------
  // Useful when an operator is debugging "why did role X get a 403" and
  // doesn't have a checkout to read DEFAULT_POLICY from source. Gated
  // by admin-only delete-on-users so the policy schema isn't visible
  // to non-admin sessions.
  app.get("/api/policy", need("users", "delete"), (_req, res) => {
    res.json({
      policy: DEFAULT_POLICY,
      roles: Object.keys(DEFAULT_POLICY),
      note: "DEFAULT_POLICY shipped with this build. Custom policies are not yet hot-reloadable.",
    });
  });

  // --- /api/audit — management-plane audit feed -------------------------
  // Read-only, gated by the "audit:read" permission so only viewers /
  // operators / admins (basically anyone authenticated in the default
  // policy) can pull it. Supports optional ?from, ?to (RFC-3339), ?actor,
  // ?action, ?limit (default 100, capped to ring size).
  app.get("/api/audit", need("audit", "read"), (req, res) => {
    const entries = mgmtAudit.list({
      from: qstr(req.query.from),
      to: qstr(req.query.to),
      actor: qstr(req.query.actor),
      action: qstr(req.query.action),
      limit: qstr(req.query.limit) ? parseInt(qstr(req.query.limit)!, 10) : undefined,
    });
    res.json({ entries, tipHash: mgmtAudit.tipHash, persisted: !!process.env.OMCP_MGMT_AUDIT_FILE });
  });

  // --- /api/usage — per-identity MCP rate-limit snapshot -----------------
  // Read-only view of the IdentityRateLimiter's bucket state. Gated by
  // need("audit","read") — the same role set that already sees the
  // audit log can see who is calling what. Anonymous /mcp traffic
  // never enters a bucket so it doesn't show up here.
  app.get("/api/usage", need("audit", "read"), (req, res) => {
    const actor = qstr(req.query.actor);
    const ids = actor ? [actor] : toolRateLimiter.knownIdentities();
    const now = Date.now();
    const identities = ids.map((id) => {
      const s = toolRateLimiter.inspect(id, now);
      return { actor: id, count: s.count, limit: s.limit, windowMs: s.windowMs };
    });
    res.json({
      identities,
      defaultLimit: resolveToolRatePerMin(process.env.OMCP_TOOL_RATE_PER_MIN),
      windowMs: 60_000,
    });
  });

  // --- /api/auth/* — login + logout for basic mode -----------------------
  // Login: POST { username, password } → 200 + Set-Cookie on success, 401
  // on bad creds, 400 on missing fields, 503 in anonymous mode (the UI
  // shouldn't have rendered the modal at all in that case but we still
  // answer cleanly). Logout: POST → 204 + clears the cookie.
  const loginRateLimit = rateLimit({
    windowMs: 60_000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "too many login attempts, slow down" },
  });
  // Cached users-file mtime — on every login we stat the file and
  // re-read when it's changed since the last check. Adding/removing
  // a user therefore takes effect on the next login attempt, no server
  // restart required. Cheap path: a single stat() per attempt; the
  // rate limit caps that at 20/min/IP anyway.
  let lastUsersMtimeMs: number | null = null;
  async function maybeReloadUsers(): Promise<void> {
    const path = process.env.OMCP_USERS_FILE;
    if (!path) return;
    try {
      const { stat } = await import("node:fs/promises");
      const st = await stat(path);
      const mtime = st.mtimeMs;
      if (lastUsersMtimeMs === null || mtime !== lastUsersMtimeMs) {
        const fresh = await readUsersFile(path);
        if (fresh && fresh.users.length > 0) {
          usersStore = fresh;
          lastUsersMtimeMs = mtime;
          if (lastUsersMtimeMs !== null) {
            console.log(`[auth] OMCP_USERS_FILE changed — reloaded ${fresh.users.length} user(s)`);
          }
        }
      }
    } catch {
      // File transiently unreadable — keep the cached store; logins
      // will continue to work with the last known set.
    }
  }
  // Prime the cache so the first login doesn't log "changed" on every boot.
  if (authRuntime.mode === "basic") {
    const path = process.env.OMCP_USERS_FILE;
    if (path) {
      try {
        const { statSync } = await import("node:fs");
        lastUsersMtimeMs = statSync(path).mtimeMs;
      } catch { /* ignore — first login will pick it up */ }
    }
  }

  app.post("/api/auth/login", loginRateLimit, async (req, res) => {
    if (authRuntime.mode !== "basic" || !sessionCfg || !usersStore) {
      res.status(503).json({ error: "auth mode does not accept logins" });
      return;
    }
    await maybeReloadUsers();
    const body = (req.body || {}) as { username?: unknown; password?: unknown };
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || !password) {
      res.status(400).json({ error: "username and password are required" });
      return;
    }
    const user = authenticate(username, password, usersStore);
    if (!user) {
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    const { cookie } = issueSession(
      { sub: user.username, name: user.name, roles: user.roles },
      sessionCfg,
    );
    const secure = req.secure || (req.headers["x-forwarded-proto"] === "https");
    res.setHeader("Set-Cookie", setCookieHeader(cookie, sessionCfg, { secure }));
    res.json({
      ok: true,
      user: { sub: user.username, name: user.name, roles: user.roles ?? [] },
    });
  });
  // Same per-IP cap as login — defends against logout-as-disruption
  // (an attacker spamming logouts at a forged session for another tab).
  app.post("/api/auth/logout", loginRateLimit, (req, res) => {
    if (authRuntime.mode !== "basic" || !sessionCfg) {
      res.status(204).end();
      return;
    }
    const secure = req.secure || (req.headers["x-forwarded-proto"] === "https");
    res.setHeader("Set-Cookie", clearCookieHeader(sessionCfg, { secure }));
    res.status(204).end();
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
  // Phase 3: edit the product catalog. Same admin model as the RBAC write.
  app.put("/api/enterprise/catalog", async (req, res) => {
    const cred = resolveToken(
      extractToken(req.headers as Record<string, unknown>),
      loadCredentials()
    );
    const principal = cred ? cred.name : null;
    const authz = await authorizeAdmin(principal);
    if (!authz.ok) return res.status(authz.status).json({ error: authz.error });
    const result = await updateCatalog(principal as string, req.body);
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
  app.post("/api/connectors/install", installRateLimit, need("connectors","write"), audit("connectors","write"), async (req, res) => {
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
    need("connectors", "write"), audit("connectors","write"),
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
  app.post("/api/sources", installRateLimit, need("sources","write"), audit("sources","write"), async (req, res) => {
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
  app.put("/api/sources/:name", need("sources","write"), audit("sources","write"), async (req, res) => {
    const oldName = String(req.params.name);
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
  app.delete("/api/sources/:name", need("sources","delete"), audit("sources","delete"), async (req, res) => {
    const name = String(req.params.name);
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
  app.post("/api/sources/test", installRateLimit, need("sources","write"), audit("sources","write"), async (req, res) => {
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
  app.patch("/api/sources/:name/toggle", need("sources","write"), audit("sources","write"), async (req, res) => {
    const name = String(req.params.name);
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
      const parsed = parseToolResult(result) as { services?: Array<Record<string, unknown> & { name?: string }> };
      // Enrich each entry with the catalog metadata (no-op when empty).
      if (parsed?.services) {
        for (const s of parsed.services) {
          const entry = typeof s.name === "string" ? catalog.get(s.name) : undefined;
          if (entry) s.catalog = entry;
        }
      }
      res.json(parsed);
    } catch { res.status(500).json({ error: "Failed to list services" }); }
  });

  // Read-only view of the configured catalog. Gated by the same
  // "catalog:read" permission Phase E4 added to DEFAULT_POLICY.
  app.get("/api/catalog", need("catalog", "read"), (_req, res) => {
    res.json({
      services: catalog.list(),
      count: catalog.count(),
      configured: !!process.env.OMCP_SERVICE_CATALOG_FILE,
    });
  });

  // Health endpoint for UI dashboard
  app.get("/api/health/:service", async (req, res) => {
    try {
      const service = String(req.params.service);
      const result = await getServiceHealthHandler(registry, { service }, defaultContext());
      const parsed = parseToolResult(result) as Record<string, unknown>;
      const entry = catalog.get(service);
      if (entry && parsed && typeof parsed === "object") parsed.catalog = entry;
      res.json(parsed);
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
          const h = parseToolResult(result) as Record<string, unknown>;
          const entry = catalog.get(svc.name);
          if (entry && h && typeof h === "object") h.catalog = entry;
          health[svc.name] = h;
        } catch { health[svc.name] = { error: "failed to fetch health" }; }
      }
      res.json(health);
    } catch {
      res.status(500).json({ error: "Failed to get health data" });
    }
  });

  // --- Topology API ---
  // Returns the union of topology snapshots across all topology-capable
  // connectors (today only "kubernetes"). One JSON document so the UI can
  // render summary + grouped views without N round-trips.
  app.get("/api/topology", async (_req, res) => {
    try {
      const sources: Array<{
        source: string;
        type: string;
        revision: number;
        resources: number;
        edges: number;
      }> = [];
      const allResources = [];
      const allEdges = [];
      for (const c of registry.getAll()) {
        if (!isTopologyProvider(c)) continue;
        const snap = await c.getTopologySnapshot();
        sources.push({
          source: snap.source,
          type: c.type,
          revision: snap.revision,
          resources: snap.resources.length,
          edges: snap.edges.length,
        });
        allResources.push(...snap.resources);
        allEdges.push(...snap.edges);
      }
      res.json({ sources, resources: allResources, edges: allEdges });
    } catch (err) {
      console.error("topology endpoint failed:", err);
      res.status(500).json({ error: "Failed to read topology" });
    }
  });

  // --- Settings API ---

  // Get general settings
  app.get("/api/settings", (_req, res) => {
    res.json(config.settings);
  });

  // Update general settings
  app.put("/api/settings", need("settings","write"), audit("settings","write"), (req, res) => {
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

  app.put("/api/health-thresholds", need("health","write"), audit("health","write"), (req, res) => {
    config = { ...config, healthThresholds: { ...config.healthThresholds, ...req.body } };
    applyConfigToRuntime(config, registry);
    saveConfig(config);
    res.json({ ok: true, healthThresholds: config.healthThresholds });
  });

  // --- Per-Source Metrics API ---

  // Get metrics for a source (active metrics or defaults)
  app.get("/api/sources/:name/metrics", (req, res) => {
    const connector = registry.getByName(String(req.params.name));
    if (!connector) {
      res.status(404).json({ error: `Source "${String(req.params.name)}" not found` });
      return;
    }
    res.json({
      metrics: connector.getMetrics(),
      defaults: connector.getDefaultMetrics(),
    });
  });

  // Update metrics for a source
  app.put("/api/sources/:name/metrics", need("sources","write"), audit("sources","write"), async (req, res) => {
    const name = String(req.params.name);
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
  app.delete("/api/sources/:name/metrics", need("sources","write"), audit("sources","write"), async (req, res) => {
    const name = String(req.params.name);
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
  // Per-identity sliding-window rate limit on the MCP HTTP transport.
  // Each request from a named bearer-token caller increments that
  // caller's bucket; once the per-window cap is hit the server replies
  // 429 with a Retry-After. Anonymous /mcp traffic (no OMCP_API_KEYS
  // configured) bypasses this — the global express-rate-limit IP gate
  // still applies. Override via OMCP_TOOL_RATE_PER_MIN.
  const toolRateLimiter = new IdentityRateLimiter({
    limit: resolveToolRatePerMin(process.env.OMCP_TOOL_RATE_PER_MIN),
  });

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
    const decision = toolRateLimiter.check(cred.name);
    // Standard RateLimit response headers — let well-behaved clients
    // self-pace before they hit a 429. Emitted on BOTH allowed and
    // denied paths so the caller always sees the live state.
    res.setHeader("X-RateLimit-Limit", String(decision.limit));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, decision.limit - decision.count)));
    res.setHeader("X-RateLimit-Window-Ms", String(decision.windowMs));
    if (!decision.allowed) {
      res.setHeader("Retry-After", String(decision.retryAfterSeconds));
      res.status(429).json({
        error: "rate limit exceeded for identity",
        code: "OMCP_IDENTITY_RATE_LIMIT",
        retryAfterSeconds: decision.retryAfterSeconds,
        limit: decision.limit,
        windowMs: decision.windowMs,
      });
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
