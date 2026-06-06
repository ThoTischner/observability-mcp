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
import { defaultContext, principalContext, sessionContext, allowsTool, type RequestContext } from "./context.js";
import { parseKeyTenants } from "./tenancy/context.js";
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
  writeUsersFile,
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
  buildRequirePermissionFromEngine,
  hasPermission,
  listGrantedPermissions,
  DEFAULT_POLICY,
  type Permission,
  type Resource,
  type Action,
} from "./auth/rbac.js";
import { resolveOidcConfig, buildOidcRuntime } from "./auth/oidc/runtime.js";
import { registerOidcRoutes } from "./auth/oidc/endpoints.js";
import { BuiltinPolicyEngine, type PolicyEngine } from "./auth/policy/engine.js";
import { loadPolicyFromFile, writePolicyFile, PolicyLoadError, VALID_RESOURCES, VALID_ACTIONS } from "./auth/policy/loader.js";
import { OpaPolicyEngine } from "./auth/policy/opa.js";
import { evaluateBatch, batchResultToCsv } from "./auth/policy/batch-dry-run.js";
import { AuditLog } from "./audit/log.js";
import { buildAuditMiddleware } from "./audit/middleware.js";
import { WebhookSink } from "./audit/sinks/webhook.js";
import type { AuditSink } from "./audit/sinks/types.js";
import { buildBypassBreadcrumb, buildBypassAuditParams } from "./audit/redaction-bypass.js";
import { readCatalogFile, CatalogStore } from "./catalog/loader.js";
import { readProductsFile, ProductsStore, validateProduct, writeProductsFile, ProductsLoadError } from "./products/loader.js";
import { REGISTERED_TOOL_NAMES, REGISTERED_TOOLS, unknownToolNames } from "./tools/registry-names.js";
import { redactValue } from "./policy/redact.js";
import { IdentityRateLimiter, resolveToolRatePerMin, parseKeyRateLimits } from "./quota/limiter.js";
import { TokenBudget, estimateTokensFor, resolveDailyTokenLimit } from "./quota/token-budget.js";
import { applyBudgetDecision } from "./quota/charge.js";
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
import { initOtel } from "./observability/otel.js";
import { WebSocketServerTransport } from "./transport/websocket.js";
import { HookRegistry } from "./sdk/hooks.js";
import { UpstreamClient } from "./federation/upstream.js";
import { FederationRegistry, parseFederationEnv } from "./federation/registry.js";
import { buildCsrfIssuer, buildCsrfEnforcer, csrfBypassFromEnv } from "./auth/csrf.js";
import { checkOutboundUrl, ssrfGuardFromEnv } from "./middleware/ssrfGuard.js";
import { buildOpenApiSpec } from "./openapi.js";
import { listSourcesHandler } from "./tools/list-sources.js";
import { listServicesHandler } from "./tools/list-services.js";
import { queryMetricsHandler } from "./tools/query-metrics.js";
import { queryLogsHandler } from "./tools/query-logs.js";
import { queryTracesHandler } from "./tools/query-traces.js";
import { getAnomalyHistoryHandler } from "./tools/get-anomaly-history.js";
import { generatePostmortemHandler } from "./tools/generate-postmortem.js";
import { AnomalyHistory, fromEnv as anomalyHistoryFromEnv } from "./analysis/history.js";
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

/** Forensic breadcrumb for redaction-bypass tool invocations.
 *
 * Deliberately omits the principal identifier: the credential name
 * lives in OMCP_API_KEYS, and threading any derivative of it into the
 * log channel re-introduces a leak surface that static analysers
 * (rightly) flag. SIEM cross-correlation goes via the correlationId
 * UUID — slice 2 will wire the management-plane audit chain to carry
 * the same correlationId alongside the (chain-protected) principal,
 * so a downstream investigator can join the two channels there.
 */
function emitBypassEvent(
  event: "redaction_bypass_engaged" | "redaction_bypass_denied",
  ctx: RequestContext,
  args: unknown,
): void {
  console.error(JSON.stringify(buildBypassBreadcrumb(event, ctx, args)));
}

/** Bridge from the new PolicyEngine to the existing
 *  hasPermission/buildRequirePermission signatures (which still take
 *  a plain {role: Permission[]} map). Built-in engine exposes the
 *  raw map directly; engines that don't (slice 4's OPA) will fall
 *  back to a synthesized one via .list(). */
function policyEngineToMap(engine: PolicyEngine): Record<string, Permission[]> {
  if (engine instanceof BuiltinPolicyEngine) return engine.raw();
  const out: Record<string, Permission[]> = {};
  for (const role of engine.roles()) {
    out[role] = engine.list([role]);
  }
  return out;
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
  // Phase F11: delegate to the shared SSRF guard. Strict by default;
  // operators add OMCP_ALLOW_PRIVATE_BACKENDS=true to allow in-cluster
  // backends. Cloud-metadata IPs (AWS 169.254.169.254, GCE
  // fd00:ec2::254) are rejected regardless.
  const v = checkOutboundUrl(url, ssrfGuardFromEnv());
  if (!v.allow) return v.reason ?? `URL "${url}" is rejected by the SSRF guard`;
  // Extra Google-metadata-hostname check (DNS-based, not in the
  // numeric guard).
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "metadata.google.internal") {
      return "Access to cloud metadata endpoints is not allowed.";
    }
  } catch {
    /* already caught by checkOutboundUrl */
  }
  return null;
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

  // OpenTelemetry self-tracing — opt-in via OMCP_OTEL_ENABLED. Init
  // before express() so HTTP auto-instrumentation captures every
  // /api/* and /mcp request. Skipped in stdio mode (no HTTP surface
  // and the auto-instrumentation would emit noise per stdio call).
  if (!STDIO) {
    await initOtel({ serviceVersion: process.env.npm_package_version });
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
  function enrichToolServicesText<T extends { content: Array<{ text: string }> }>(result: T, ctx: RequestContext): T {
    try {
      const parsed = JSON.parse(result.content[0]?.text ?? "{}");
      if (parsed && Array.isArray(parsed.services)) {
        for (const s of parsed.services) {
          // Scope enrichment to the caller's tenant so we don't
          // leak owner / on-call / SLO bytes for other tenants'
          // services that happen to share a name in the catalog.
          const entry = typeof s?.name === "string" ? catalog.get(s.name, ctx.tenant) : undefined;
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
  /** Charge the estimated tokens in a tool response against the
   *  per-identity daily budget. When the budget would be exceeded,
   *  replace the response with a structured error payload —
   *  the tool's data never crosses the boundary, and the agent
   *  sees a parseable {error: "OMCP_TOKEN_BUDGET_EXCEEDED", ...}
   *  rather than a generic failure. Anonymous principals are not
   *  charged (the budget is per-credential).
   *
   *  This charges RETROACTIVELY: the tool body has already executed,
   *  so the work is done by the time we decide to deny — the call
   *  that flips the bucket over the cap still pays the cost; the
   *  N+1 call denies before doing work. Pre-flight denial would
   *  require predicting response size before the connector runs,
   *  which isn't tractable for query_logs / query_metrics where
   *  size is data-dependent. The trade-off is intentional: one
   *  over-cap call per bucket roll vs an unhelpful "request denied,
   *  size unknown" upstream. */
  function chargeTokenBudget<T extends { content: Array<{ text: string }> }>(
    result: T,
    ctx: RequestContext,
    toolName: string,
  ): T {
    if (ctx.auth !== "apikey") return result;
    const text = result.content[0]?.text ?? "";
    const tokens = estimateTokensFor(text);
    const decision = tokenBudget.check(identityKey(ctx), tokens);
    return applyBudgetDecision(result, decision, tokens, toolName);
  }

  const REDACTION_ENABLED = String(process.env.OMCP_REDACTION ?? "on").toLowerCase() !== "off";
  function redactToolText<T extends { content: Array<{ text: string }> }>(
    result: T,
    opts: { bypass?: boolean } = {},
  ): T {
    if (!REDACTION_ENABLED) return result;
    if (opts.bypass) return result;
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

  function enrichToolHealthText<T extends { content: Array<{ text: string }> }>(result: T, serviceName: string, ctx: RequestContext): T {
    try {
      const parsed = JSON.parse(result.content[0]?.text ?? "{}");
      const entry = serviceName ? catalog.get(serviceName, ctx.tenant) : undefined;
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
  // Product-aware registration: when the active credential is bound
  // to a Product (OMCP_KEY_PRODUCTS), `ctx.allowedTools` carries that
  // Product's `tools` allow-list and we skip the registration of any
  // tool not in it. Anonymous + Product-less sessions leave
  // allowedTools undefined and see every tool — the bypass is the
  // back-compat path the open-source default relies on.
  //
  // The wrapper also wires Phase F7 hook fan-out: every tool dispatch
  // fires tool_pre_invoke before the handler and tool_post_invoke after.
  // Plugins can deny the call (allow:false → isError CallToolResult),
  // mutate the args before dispatch, or mutate the result before it
  // reaches the caller. When no hooks are registered (the default in
  // the OSS demo) the wrapper is a thin pass-through.
  const registerTool = ((name: string, ...rest: unknown[]) => {
    if (!allowsTool(ctx.allowedTools, name)) return undefined as never;
    if (rest.length > 0 && typeof rest[rest.length - 1] === "function") {
      const originalHandler = rest[rest.length - 1] as (...a: unknown[]) => unknown;
      const wrappedHandler = async (args: unknown, extra: unknown) => {
        const hookCtxBase = {
          principal: ctx.principalId,
          tenant: ctx.tenant || "default",
          target: name,
        };
        const pre = await hookRegistry.fire(
          "tool_pre_invoke",
          { ...hookCtxBase, kind: "tool_pre_invoke" as const },
          { args },
        );
        if (!pre.allow) {
          return {
            content: [{ type: "text", text: pre.reason ?? "denied by plugin hook" }],
            isError: true,
          };
        }
        const effectiveArgs = (pre.payload as { args?: unknown } | undefined)?.args ?? args;
        const result = await originalHandler(effectiveArgs, extra);
        const post = await hookRegistry.fire(
          "tool_post_invoke",
          { ...hookCtxBase, kind: "tool_post_invoke" as const },
          { args: effectiveArgs, result },
        );
        if (!post.allow) {
          return {
            content: [{ type: "text", text: post.reason ?? "denied by plugin hook" }],
            isError: true,
          };
        }
        return (post.payload as { result?: unknown } | undefined)?.result ?? result;
      };
      rest[rest.length - 1] = wrappedHandler;
    }
    return (mcpServer.tool as unknown as (...a: unknown[]) => unknown)(name, ...rest) as never;
  }) as typeof mcpServer.tool;

  registerTool(
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

  registerTool(
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
      return enrichToolServicesText(result, ctx);
    }
  );

  const metricsList = getAvailableMetricNames(registry);
  const metricNames = registry.getBySignal("metrics").flatMap(c => c.getMetrics().map(m => m.name));
  const uniqueNames = [...new Set(metricNames)];

  registerTool(
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
      const result = await withToolMetrics("query_metrics", () => queryMetricsHandler(registry, args, ctx));
      return chargeTokenBudget(result, ctx, "query_metrics");
    }
  );

  registerTool(
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
      bypass_redaction: z
        .boolean()
        .optional()
        .describe(
          "Optional. When true, request that PII/secret redaction be skipped for this single call. The server only honours this when the calling credential was explicitly authorised via OMCP_KEY_BYPASS_REDACTION; otherwise the request still gets redacted output. Default: false.",
        ),
    },
    async (args) => {
      await enforceEntitledAccess(ctx, { tool: "query_logs", source: (args as any)?.source, service: (args as any)?.service });
      const result = await withToolMetrics("query_logs", () => queryLogsHandler(registry, args, ctx));
      // Redact PII / secrets from the log payload before it crosses the
      // MCP boundary into the agent's context. Per-call bypass kicks in
      // only when BOTH (a) the credential is OMCP_KEY_BYPASS_REDACTION
      // allow-listed, AND (b) the agent explicitly opted in via the
      // bypass_redaction arg. Either alone keeps redaction on, so
      // configuration-only and arg-only paths both fail closed.
      const wantsBypass = (args as { bypass_redaction?: boolean })?.bypass_redaction === true;
      const allowed = ctx.allowBypassRedaction === true;
      const bypass = wantsBypass && allowed;
      if (bypass || (wantsBypass && !allowed)) {
        // Forensic trail:
        //   1. stderr breadcrumb for SIEM tail-and-forward setups (the
        //      log channel keeps no identifying credential reference
        //      to avoid CodeQL taint findings — correlation goes via
        //      the audit chain entry below).
        //   2. management-plane audit chain entry so the bypass
        //      invocation is tamper-evident alongside the rest of
        //      /api/*. Persists if OMCP_MGMT_AUDIT_FILE is set.
        emitBypassEvent(bypass ? "redaction_bypass_engaged" : "redaction_bypass_denied", ctx, args);
        void mgmtAudit.record(buildBypassAuditParams(bypass, ctx, args)).catch(() => {
          // Audit record is best-effort — losing one entry must not
          // crash the tool call. The chain itself remains intact.
        });
      }
      const redacted = redactToolText(result, { bypass });
      return chargeTokenBudget(redacted, ctx, "query_logs");
    }
  );

  registerTool(
    "get_anomaly_history",
    [
      "Replay historical anomaly scores for a service from the TSDB the gateway writes to (omcp_anomaly_score series).",
      "When to use: post-mortem reconstruction, trend analysis on detector noise, or pulling context for the LLM when an incident is reviewed after the fact.",
      "Prerequisites: the operator must have OMCP_ANOMALY_HISTORY_REMOTE_WRITE configured AND a Prometheus source pointed at the same TSDB so the round-trip closes.",
      "Behavior: read-only. Returns the time-series of scores. Empty result means either no anomalies in the window or history is disabled.",
      "Related: `detect_anomalies` for the live scores; `query_metrics` if you want to write the PromQL by hand.",
    ].join(" "),
    {
      service: z.string().describe("Service name to filter on."),
      duration: z.string().optional().describe("Rolling window, e.g. '1h', '24h'. Default '1h'."),
      method: z.string().optional().describe("Filter by detector method ('mad' / 'seasonality' / 'correlator'). Optional."),
    },
    async (args) => {
      await enforceEntitledAccess(ctx, { tool: "get_anomaly_history", service: (args as { service?: string })?.service });
      const result = await withToolMetrics("get_anomaly_history", () => getAnomalyHistoryHandler(registry, args, ctx));
      return chargeTokenBudget(result, ctx, "get_anomaly_history");
    },
  );

  registerTool(
    "generate_postmortem",
    [
      "Stitch the gateway's primitives (anomaly history, blast-radius, traces, log highlights) into a single markdown post-mortem report for one service over a given window.",
      "When to use: after an incident, when the operator or LLM wants 'one document the on-call can read in 60 seconds' instead of poking the individual tools.",
      "Prerequisites: anomaly history requires OMCP_ANOMALY_HISTORY_REMOTE_WRITE + a Prometheus source. Traces require Tempo / Jaeger. Blast-radius requires a topology provider.",
      "Behavior: read-only. Returns markdown by default; pass `format='json'` for the structured shape. Output capped (timeline 20 rows, blast-radius 30 nodes, 10 traces) — JSON shape carries the full data.",
      "Related: `get_anomaly_history`, `query_traces`, `get_blast_radius` for the underlying primitives.",
    ].join(" "),
    {
      service: z.string().describe("Suspected root-cause service."),
      duration: z.string().optional().describe("Window length, e.g. '1h', '6h'. Default '1h'."),
      format: z.enum(["markdown", "json"]).optional().describe("'markdown' (default) or 'json'."),
    },
    async (args) => {
      await enforceEntitledAccess(ctx, { tool: "generate_postmortem", service: (args as { service?: string })?.service });
      const result = await withToolMetrics("generate_postmortem", () => generatePostmortemHandler(registry, args, ctx));
      return chargeTokenBudget(result, ctx, "generate_postmortem");
    },
  );

  registerTool(
    "query_traces",
    [
      "Query distributed traces for a service over a given timeframe.",
      "Returns ranked trace summaries (duration, span count, error status) with a p50/p95 aggregate across the returned set.",
      "When to use: investigate tail-latency outliers, walk call chains across services for a specific time window, or pull traces related to an anomaly that the metric/log tools surfaced first.",
      "Prerequisites: get the exact service name from `list_services`. A Tempo / Jaeger / OTLP connector must be configured.",
      "Behavior: read-only. `filter` accepts the backend's native query language (TraceQL on Tempo, tag query on Jaeger). When `errorsOnly=true`, only traces with at least one error span are returned. Default limit is 50.",
    ].join(" "),
    {
      service: z.string().describe("Service name (e.g. 'payment-service')."),
      duration: z.string().optional().describe("Rolling time window, e.g. '5m', '1h'. Default '15m'."),
      filter: z.string().optional().describe("Backend-native filter (TraceQL on Tempo, tag query on Jaeger). Optional."),
      limit: z.number().int().positive().optional().describe("Soft cap on returned trace summaries. Default 50."),
      errorsOnly: z.boolean().optional().describe("If true, only traces with at least one error span."),
    },
    async (args) => {
      await enforceEntitledAccess(ctx, { tool: "query_traces", service: (args as { service?: string })?.service });
      const result = await withToolMetrics("query_traces", () => queryTracesHandler(registry, args, ctx));
      return chargeTokenBudget(result, ctx, "query_traces");
    },
  );

  registerTool(
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
      const enriched = enrichToolHealthText(result, String((args as any)?.service ?? ""), ctx);
      return chargeTokenBudget(enriched, ctx, "get_service_health");
    }
  );

  registerTool(
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

  registerTool(
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

  registerTool(
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

  // Phase F10: federated tools — every upstream MCP server's tools
  // show up here under `<prefix>.<upstream-tool>`. The handler is a
  // pure proxy: it forwards args verbatim and returns the upstream's
  // CallToolResult unchanged. The wrapping registerTool() at the top
  // of this function still fires F7 lifecycle hooks + the F1
  // Product-allow-list gate, so federated tools obey the same policy
  // surface as native ones.
  for (const info of federationRegistry.getNamespacedTools()) {
    // Upstream's inputSchema is forwarded verbatim. The SDK's
    // tool() overload signatures don't carry an obvious type for a
    // dynamic-shape schema, so we cast to `any` at the boundary and
    // let the upstream contract speak for the validation.
    (registerTool as unknown as (...args: unknown[]) => unknown)(
      info.namespacedName,
      info.description || `Federated from upstream ${info.sourceName}.`,
      info.inputSchema ?? {},
      async (args: unknown) => {
        await enforceEntitledAccess(ctx, { tool: info.namespacedName });
        return withToolMetrics(info.namespacedName, () =>
          federationRegistry.callNamespacedTool(info.namespacedName, args),
        );
      },
    );
  }

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

  // Phase F11: CSRF — double-submit cookie pattern, enforced on every
  // mutating /api/* request. The issuer runs top-of-pipe so any page
  // render leaves a CSRF token cookie the SPA can read + echo back.
  // Bearer-token clients (CI, agents, MCP clients) bypass by default
  // since they can't be a browser confused-deputy.
  const csrfCfg = {
    bypassBearer: csrfBypassFromEnv(),
    secureCookie: (r: import("express").Request) =>
      r.secure || r.headers["x-forwarded-proto"] === "https",
  };
  app.use(buildCsrfIssuer(csrfCfg));
  app.use("/api", buildCsrfEnforcer(csrfCfg));

  // Active policy engine — built-in DEFAULT_POLICY by default. When
  // OMCP_RBAC_POLICY_FILE is set we load it and ALWAYS abort on
  // failure: OMCP_AUTH_ALLOW_FALLBACK is for *auth-mode* fallback
  // (basic → anonymous), not for the policy file. An operator who
  // deployed a restrictive policy to TIGHTEN the default would be
  // worse off silently inheriting the broader built-in
  // (DEFAULT_POLICY grants admin → redaction:bypass) than crashing
  // with a clear error. Policy file errors are unconditionally
  // fatal so the configured intent always wins.
  let policyEngine: PolicyEngine = new BuiltinPolicyEngine(DEFAULT_POLICY);
  const policyFile = process.env.OMCP_RBAC_POLICY_FILE?.trim();
  const opaUrl = process.env.OMCP_OPA_URL?.trim();
  // OPA takes precedence over a file: an operator who wired both
  // probably wants OPA as the live engine and uses the file as a
  // local fallback only via OMCP_POLICY_ENGINE=builtin.
  const enginePref = (process.env.OMCP_POLICY_ENGINE || "").toLowerCase();
  if (opaUrl && enginePref !== "builtin") {
    const declared = (process.env.OMCP_OPA_ROLES || "").split(",").map((s) => s.trim()).filter(Boolean);
    policyEngine = new OpaPolicyEngine({
      url: opaUrl,
      packagePath: process.env.OMCP_OPA_PACKAGE || "observability/authz",
      declaredRoles: declared.length > 0 ? declared : undefined,
      bearerToken: process.env.OMCP_OPA_TOKEN || undefined,
    });
    console.log(`[auth] RBAC policy engine = OPA at ${opaUrl} (package ${process.env.OMCP_OPA_PACKAGE || "observability/authz"})`);
    // Pre-warm: the sync RBAC gate denies on a cache miss while the
    // first async OPA call is in flight. Hit every (role, resource,
    // action) combination from the declared role set so the very
    // first user request gets a real decision instead of a warming-
    // deny. With 3 roles × 10 resources × 4 actions = 120 calls,
    // OPA handles this in <1s and we keep it best-effort (any
    // failure surfaces in the OPA logs, the engine retries on the
    // first user-facing call anyway).
    const opaEngine = policyEngine as OpaPolicyEngine;
    void (async () => {
      const roles = opaEngine.roles();
      if (roles.length === 0) return;
      const resources = [...VALID_RESOURCES];
      const actions = [...VALID_ACTIONS];
      // Tenant-aware pre-warm: the gate keys cache per
      // (roles, resource, action, tenant) so a tenant-conditional
      // Rego rule that fires for "acme" but not "bigco" produces a
      // distinct cached verdict per tenant. The pre-warm iterates
      // every known declared tenant + "default" so the first user
      // request from a tenant'd identity gets a real decision
      // instead of a warming-deny. OIDC tenants only known at
      // runtime are still subject to first-request warming, but
      // operator-set OMCP_KEY_TENANTS land here.
      const knownTenants = new Set<string>(["default"]);
      // parseKeyTenants is the same parser the credentials layer
      // uses, so the warm set is exactly what the gate will see.
      for (const t of parseKeyTenants(process.env.OMCP_KEY_TENANTS).values()) {
        if (t) knownTenants.add(t);
      }
      const tenants = Array.from(knownTenants);
      const tasks: Promise<unknown>[] = [];
      for (const tenant of tenants) {
        for (const role of roles) {
          for (const resource of resources) for (const action of actions) {
            tasks.push(opaEngine.warmEvaluate([role], resource, action, tenant));
          }
          tasks.push(opaEngine.warmList([role], tenant));
        }
      }
      try {
        const settled = await Promise.allSettled(tasks);
        const failed = settled.filter((s) => s.status === "rejected").length;
        const tlbl = tenants.length === 1 ? "1 tenant" : `${tenants.length} tenants`;
        if (failed === 0) {
          console.log(`[auth] OPA cache pre-warmed: ${settled.length} decisions cached for ${roles.length} role(s) × ${tlbl}`);
        } else {
          console.warn(`[auth] OPA cache pre-warmed: ${settled.length - failed}/${settled.length} ok, ${failed} failed across ${tlbl} (gates will retry on first user call)`);
        }
      } catch { /* best-effort */ }
    })();
  } else if (policyFile) {
    try {
      policyEngine = loadPolicyFromFile(policyFile);
      console.log(`[auth] RBAC policy loaded from ${policyFile} (${policyEngine.roles().join(", ")})`);
    } catch (e) {
      const reason = e instanceof PolicyLoadError ? e.message : String(e);
      console.error(`[auth] OMCP_RBAC_POLICY_FILE=${policyFile}: ${reason} — refusing to start (a malformed policy file would silently revert to the more permissive built-in default, defeating the point of the override)`);
      process.exit(1);
    }
  }

  // Use the engine-aware variant so tenant (session.tenant) flows into
  // engine.evaluate() — required for tenant-conditional Rego rules
  // (`input.tenant == "acme"` etc.) under OMCP_OPA_URL. Built-in /
  // file-loaded engines ignore the tenant ctx, so the behaviour is
  // unchanged for those deployments.
  const need = (resource: Resource, action: Action) =>
    buildRequirePermissionFromEngine(authRuntime, resource, action, policyEngine);

  // Management-plane audit log. Records one entry per mutating /api/*
  // request. Writes JSONL to disk when OMCP_MGMT_AUDIT_FILE is set;
  // otherwise an in-memory ring of the last 500 entries keeps the
  // /api/audit endpoint useful in the demo / single-user case.
  // External audit sinks — opt-in via env. Each chained entry is
  // mirrored to every configured sink; the on-disk JSONL master
  // remains the source of truth (the hash chain is never split).
  const auditSinks: AuditSink[] = [];
  if (process.env.OMCP_AUDIT_WEBHOOK_URL) {
    auditSinks.push(
      new WebhookSink({
        url: process.env.OMCP_AUDIT_WEBHOOK_URL,
        token: process.env.OMCP_AUDIT_WEBHOOK_TOKEN,
        deadLetterFile: process.env.OMCP_AUDIT_WEBHOOK_DLQ,
      }),
    );
    console.log(
      "AuditLog: webhook sink enabled -> %s%s",
      process.env.OMCP_AUDIT_WEBHOOK_URL,
      process.env.OMCP_AUDIT_WEBHOOK_DLQ
        ? ` (DLQ: ${process.env.OMCP_AUDIT_WEBHOOK_DLQ})`
        : "",
    );
  }
  const mgmtAudit = new AuditLog({
    file: process.env.OMCP_MGMT_AUDIT_FILE,
    sinks: auditSinks,
  });
  await mgmtAudit.bootstrap();
  process.on("SIGTERM", () => {
    mgmtAudit
      .flushSinks()
      .catch((err) => console.warn("AuditLog flushSinks failed:", err));
  });
  const audit = (resource: string, action: string) =>
    buildAuditMiddleware({ audit: mgmtAudit, resource, action });

  // Plugin lifecycle hook registry — populated by the loader at boot
  // (one entry per manifest `hooks[]` entry) and mutable at runtime
  // when a connector is installed via /api/connectors/install. Each
  // tool dispatch in createMcpServer fans through this registry's
  // tool_pre_invoke / tool_post_invoke chains; resource and prompt
  // hooks plug into their respective seams as they ship.
  const hookRegistry = new HookRegistry();

  // Phase F15: anomaly-history sink — opt-in via
  // OMCP_ANOMALY_HISTORY_REMOTE_WRITE. When configured, anomaly
  // scores written via anomalyHistory.record() flush to the
  // configured TSDB on a 10-second timer. The MCP tool
  // get_anomaly_history queries them back via any Prometheus source
  // pointed at the same TSDB.
  //
  // The detector-side hook that actually records per-anomaly scores
  // is plumbed in F15b (it requires passing this instance into the
  // detectAnomaliesHandler — minor surgery deferred). The
  // infrastructure ships now so externally-written omcp_anomaly_score
  // metrics are already queryable end-to-end.
  const anomalyHistory = new AnomalyHistory(anomalyHistoryFromEnv());
  anomalyHistory.start();
  if (anomalyHistory.isEnabled()) {
    console.log(
      "AnomalyHistory: TSDB sink enabled (OMCP_ANOMALY_HISTORY_REMOTE_WRITE set)",
    );
  }
  process.on("SIGTERM", () => {
    void anomalyHistory.stop().catch(() => undefined);
  });

  // Federation registry — populated from OMCP_FEDERATION_UPSTREAMS at
  // boot. Each upstream connects, fetches tools/list, and exposes its
  // tools under `<prefix>.<upstream-tool-name>` on the gateway's
  // surface. Failures are logged + the upstream is left in `degraded`
  // (no tools) so the gateway boots regardless of upstream health.
  const federationRegistry = new FederationRegistry();
  for (const cfg of parseFederationEnv()) {
    const client = new UpstreamClient({
      name: cfg.name,
      url: cfg.url,
      bearerToken: cfg.bearerToken,
    });
    federationRegistry.add(client);
    client.connect().catch((err: unknown) => {
      console.warn(
        "federation upstream %s initial connect failed: %s",
        cfg.name,
        err instanceof Error ? err.message : String(err),
      );
    });
  }
  if (federationRegistry.list().length > 0) {
    console.log(
      "federation: %d upstream(s) configured: %s",
      federationRegistry.list().length,
      federationRegistry.list().map((u) => `${u.name}=${u.url}`).join(", "),
    );
  }
  process.on("SIGTERM", () => {
    federationRegistry
      .closeAll()
      .catch((err) => console.warn("federation closeAll failed:", err));
  });

  // Service catalog: optional operator-curated ownership / criticality /
  // on-call metadata, keyed on the service name list_services returns.
  // No file ⇒ empty catalog, enrichment is a no-op (anonymous demos
  // see no behaviour change).
  const catalog = new CatalogStore(await readCatalogFile(process.env.OMCP_SERVICE_CATALOG_FILE));
  // Hot-reload aware: passing the path lets `products.maybeReload()`
  // pick up out-of-band edits to OMCP_PRODUCTS_FILE without a restart.
  // Each /api/products* handler awaits maybeReload() before reading,
  // so a `kubectl apply` of an updated ConfigMap or a git-ops edit is
  // visible on the very next request.
  const productsPath = process.env.OMCP_PRODUCTS_FILE;
  const products = new ProductsStore(await readProductsFile(productsPath), { path: productsPath });
  // Seed the mtime cursor from the file we just loaded so the first
  // maybeReload() call doesn't redundantly re-parse the boot state.
  await products.pinMtimeAfterWrite();
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

  // Procurement-time probe: the MCP spec revisions and transports the
  // gateway supports. Static today — kept as a separate endpoint so a
  // discovery tool / RFP probe / catalog scanner can resolve our
  // compliance posture without sending a real MCP handshake.
  // See docs/mcp-conformance.md for the test suite that proves it.
  app.get("/api/conformance", (_req, res) => {
    res.json({
      revisions: ["2025-11-25"],
      transports: ["streamable-http", "stdio", "websocket"],
      methods: {
        // Methods exercised by the conformance harness. "supported"
        // is the union of methods that return a non -32601 envelope
        // for any conforming caller. Per-method spec compliance is
        // proven by src/conformance/mcp-2025-11-25.test.ts.
        supported: [
          "initialize",
          "notifications/initialized",
          "ping",
          "tools/list",
          "tools/call",
        ],
        optional: [
          "resources/list",
          "resources/read",
          "prompts/list",
          "prompts/get",
          "logging/setLevel",
        ],
      },
      harnessPath: "mcp-server/src/conformance/mcp-2025-11-25.test.ts",
      docs: "docs/mcp-conformance.md",
    });
  });
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

  // List sources with health status — tenant-scoped.
  // Non-admin callers see only their own tenant's sources + globals
  // (untagged). Admins (users:delete) see everything, with optional
  // ?tenant=acme drill-down. Anonymous mode (no session) sees
  // everything — preserves single-tenant default. The `tenant` field
  // is included on every entry so the UI can render scope badges.
  app.get("/api/sources", async (req, res) => {
    const sess = (req as AuthedRequest).session;
    const isAdmin = hasPermission(sess?.roles, "users", "delete");
    const callerTenant = sess?.tenant || "default";
    const requestedTenant = qstr(req.query.tenant);
    const health = await registry.healthCheckAll();
    const configs = registry.getSourceConfigs();
    const filtered = configs.filter((c) => {
      // Anonymous: every source.
      if (!sess) return true;
      // Admin with ?tenant=X drill-down: untagged + that tenant.
      if (isAdmin && requestedTenant) return !c.tenant || c.tenant === requestedTenant;
      // Admin no filter: every source (cross-tenant view).
      if (isAdmin) return true;
      // Non-admin: own tenant + untagged.
      return !c.tenant || c.tenant === callerTenant;
    });
    const sources = filtered.map((c) => {
      const connector = registry.getByName(c.name);
      return {
        name: c.name,
        type: c.type,
        url: c.url,
        enabled: c.enabled,
        auth: c.auth ? { type: c.auth.type } : undefined,
        tls: c.tls || undefined,
        tenant: c.tenant,
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

  // Get the registry of MCP tools the server can advertise (name +
  // category + one-line summary). The Products modal uses this to
  // populate the tools-allowlist picker so a typo can't happen at
  // authoring time; the server-side typo guard (PR #343) stays as
  // defence-in-depth. Open to every viewer — there's nothing
  // sensitive in the catalogue, it's just static metadata.
  app.get("/api/tools/registry", (_req, res) => {
    res.json({ tools: REGISTERED_TOOLS });
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
      user: {
        sub: sess.sub,
        name: sess.name,
        email: sess.email,
        tenant: sess.tenant || "default",
        roles: sess.roles ?? [],
      },
      permissions: listGrantedPermissions(sess.roles, policyEngineToMap(policyEngine)),
      exp: sess.exp,
      // When the user signed in via OIDC, surface the IdP issuer
      // URL so the UI can render an appropriate badge or link to
      // an IdP-side profile page. Empty / absent in basic mode.
      idpIssuer: authRuntime.mode === "oidc" ? (oidcRuntime?.cfg.issuer ?? "") : undefined,
    });
  });

  // --- /api/policy — read-only view of the RBAC policy in effect -------
  // Useful when an operator is debugging "why did role X get a 403" and
  // doesn't have a checkout to read DEFAULT_POLICY from source. Gated
  // by admin-only delete-on-users so the policy schema isn't visible
  // to non-admin sessions.
  app.get("/api/policy", need("users", "delete"), (req, res) => {
    const map = policyEngineToMap(policyEngine);
    // The OPA engine's kind() is prefixed `opa:` (see opa.ts:198).
    // Surface a `tenantAware` boolean so operators can confirm at a
    // glance whether the active engine honours session.tenant in
    // .evaluate() — the BuiltinPolicyEngine ignores tenant ctx; OPA
    // threads it into the Rego input. This is the property required
    // for `allow { input.tenant == "acme" }` rules to actually fire.
    const tenantAware = policyEngine.kind().startsWith("opa:");
    // Optional dry-run: ?roles=admin,operator&resource=sources&action=delete[&tenant=acme]
    // returns { allowed, reason } so operators can probe the active
    // engine without writing tests against a checkout. Tenant defaults
    // to the caller's session tenant; an admin can override via the
    // ?tenant= query string to probe verdicts for any tenant.
    const q = req.query as Record<string, string | undefined>;
    if (q.resource && q.action) {
      const dryRoles = typeof q.roles === "string" ? q.roles.split(",").map((r) => r.trim()).filter(Boolean) : undefined;
      // Validate the probe values against the active vocabulary so
      // an operator typo doesn't get a misleading "allowed:false
      // reason: roles do not grant <typo>" reply.
      if (!VALID_RESOURCES.has(q.resource as Resource)) {
        res.json({ dryRun: { roles: dryRoles ?? [], resource: q.resource, action: q.action, allowed: false, reason: `unknown resource '${q.resource}' (valid: ${[...VALID_RESOURCES].join(", ")})` } });
        return;
      }
      if (!VALID_ACTIONS.has(q.action as Action)) {
        res.json({ dryRun: { roles: dryRoles ?? [], resource: q.resource, action: q.action, allowed: false, reason: `unknown action '${q.action}' (valid: ${[...VALID_ACTIONS].join(", ")})` } });
        return;
      }
      const callerSess = (req as AuthedRequest).session;
      // Tenant resolution: explicit ?tenant= override wins, else the
      // caller's session tenant. The probe runs at users:delete (admin),
      // so a cross-tenant override is intentional — exactly how an
      // operator debugs "why doesn't my tenant-conditional Rego rule
      // fire for tenant Acme?".
      const probeTenant = typeof q.tenant === "string" && q.tenant
        ? q.tenant.trim()
        : callerSess?.tenant;
      const result = policyEngine.evaluate(
        dryRoles,
        q.resource as Resource,
        q.action as Action,
        probeTenant ? { tenant: probeTenant } : undefined,
      );
      res.json({
        dryRun: {
          roles: dryRoles ?? [],
          resource: q.resource,
          action: q.action,
          tenant: probeTenant,
          ...result,
        },
      });
      return;
    }
    res.json({
      engine: policyEngine.kind(),
      tenantAware,
      policy: map,
      roles: policyEngine.roles(),
      note: policyEngine.kind() === "builtin"
        ? "DEFAULT_POLICY shipped with this build. Set OMCP_RBAC_POLICY_FILE to override."
        : `policy loaded from ${policyEngine.kind()}; restart to reload.`,
    });
  });

  // Phase F16: batch policy dry-run. Evaluates every
  // (subject × resource × action) cell against the active engine and
  // returns a matrix the UI heat-map renders. Gated identically to
  // the single-call dry-run on GET /api/policy. Capped at 100×100×10
  // cells per request — a single OPA query per cell is cheap on the
  // BuiltinPolicyEngine but a careless caller could hose an external
  // OPA, so the limit fences that. Operators get CSV via
  // Accept: text/csv for ticket attachments.
  app.post("/api/policy/dry-run-batch", need("users", "delete"), audit("policy", "read"), async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subjects = Array.isArray(body.subjects) ? body.subjects : [];
    const resources = Array.isArray(body.resources) ? body.resources : [];
    const actions = Array.isArray(body.actions) ? body.actions : [];
    const result = await evaluateBatch(
      policyEngine,
      { subjects, resources, actions } as never,
      VALID_RESOURCES as unknown as Set<string>,
      VALID_ACTIONS as unknown as Set<string>,
    );
    if (req.headers["accept"]?.toString().includes("text/csv")) {
      res.type("text/csv").send(batchResultToCsv(result));
      return;
    }
    res.json(result);
  });

  // --- /api/subjects — aggregated principals catalogue ------------------
  // The third k8s-shaped RBAC view: who the deployment knows about.
  // Three independent sources, returned in three independent arrays so
  // the UI can table each section separately:
  //   - users     : OMCP_USERS_FILE (basic-mode local users). Password
  //                 hashes are never returned.
  //   - apiKeys   : OMCP_API_KEYS names (the bearer-token catalogue).
  //                 Tokens are never returned; only metadata (tenant,
  //                 bound product, source allow-list, bypass flag).
  //   - oidcGroups: keys of OMCP_OIDC_ROLE_MAP — every group the
  //                 operator has explicitly mapped to an OMCP role.
  //                 Runtime-only groups (claims that arrive without an
  //                 OMCP-side mapping) are skipped on purpose; they
  //                 produce no roles by definition.
  // Gated identically to /api/policy.
  app.get("/api/subjects", need("users", "delete"), async (_req, res) => {
    // Local users.
    const usersOut: Array<{ username: string; name: string; roles: string[]; tenant: string }> = [];
    if (process.env.OMCP_USERS_FILE) {
      try {
        const f = await readUsersFile(process.env.OMCP_USERS_FILE);
        if (f && Array.isArray(f.users)) {
          for (const u of f.users) {
            usersOut.push({
              username: u.username,
              name: u.name,
              roles: u.roles ? u.roles.slice() : [],
              tenant: u.tenant || "default",
            });
          }
        }
      } catch (e) {
        // Read failures don't 500 the whole endpoint — surface an
        // empty users array; admins can check the boot log for the
        // file-load diagnostic.
        console.warn(`[/api/subjects] readUsersFile failed: ${(e as Error).message}`);
      }
    }
    // API key credentials (tokens stripped).
    const apiKeysOut: Array<{
      name: string;
      tenant: string;
      productId?: string;
      bypassRedaction: boolean;
      allowedSources?: string[];
    }> = [];
    for (const c of loadCredentials()) {
      apiKeysOut.push({
        name: c.name,
        tenant: c.tenant || "default",
        productId: c.productId,
        bypassRedaction: !!c.bypassRedaction,
        allowedSources: c.allowedSources,
      });
    }
    // OIDC groups → role mappings.
    const oidcGroupsOut: Array<{ claim: string; role: string }> = [];
    const roleMapRaw = process.env.OMCP_OIDC_ROLE_MAP;
    if (roleMapRaw) {
      try {
        const parsed = JSON.parse(roleMapRaw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [claim, role] of Object.entries(parsed)) {
            if (typeof role === "string" && claim) {
              oidcGroupsOut.push({ claim, role });
            }
          }
        }
      } catch {
        // The OIDC runtime already rejects an invalid role map at
        // boot — if parsing fails here it's almost certainly a
        // transient state during config reload. Surface empty.
      }
    }
    res.json({
      users: usersOut,
      apiKeys: apiKeysOut,
      oidcGroups: oidcGroupsOut,
      // Surface which env vars actually drive each list so an
      // admin diagnosing "where is my user?" sees the source path
      // without having to read the deploy.
      sources: {
        users: process.env.OMCP_USERS_FILE || null,
        apiKeys: process.env.OMCP_API_KEYS ? "OMCP_API_KEYS" : null,
        oidcGroups: process.env.OMCP_OIDC_ROLE_MAP ? "OMCP_OIDC_ROLE_MAP" : null,
      },
    });
  });

  // Update a user's roles. Today this is the only binding-shape that
  // OMCP can actually mutate at runtime: api-key roles aren't stored
  // anywhere (creds carry sources / tenant / product but not roles),
  // and OIDC group → role mappings come from OMCP_OIDC_ROLE_MAP which
  // is read once at boot. The Bindings UI surface api-key + oidc rows
  // explain the env-source path instead of offering an edit affordance.
  app.put("/api/users/:username/roles", need("users", "delete"), audit("users", "write"), async (req, res) => {
    const username = String(req.params.username);
    const path = process.env.OMCP_USERS_FILE;
    if (!path) {
      res.status(409).json({ error: "OMCP_USERS_FILE is not configured — basic-mode user roles can't be edited via the API." });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || !Array.isArray(body.roles) || !body.roles.every((r) => typeof r === "string")) {
      res.status(400).json({ error: "body must include { roles: string[] }" });
      return;
    }
    const requestedRoles = body.roles as string[];
    // Reject role names not in the active policy engine's catalogue —
    // assigning a user a role that grants nothing is almost always a
    // typo, not intent. Same defence-in-depth posture as the products
    // typo guard (PR #343).
    const knownRoles = new Set(policyEngine.roles());
    const unknown = requestedRoles.filter((r) => !knownRoles.has(r));
    if (unknown.length > 0) {
      res.status(422).json({
        error: `unknown role name(s) for user '${username}': ${unknown.join(", ")}`,
        code: "OMCP_USER_UNKNOWN_ROLE",
        unknown,
        available: Array.from(knownRoles),
      });
      return;
    }
    const file = await readUsersFile(path);
    if (!file) {
      res.status(404).json({ error: `users file at ${path} is unreadable or empty` });
      return;
    }
    const idx = file.users.findIndex((u) => u.username === username);
    if (idx < 0) {
      res.status(404).json({ error: `user '${username}' not found` });
      return;
    }
    file.users[idx].roles = requestedRoles;
    try {
      await writeUsersFile(path, file);
    } catch (e) {
      res.status(500).json({ error: `failed to persist users file: ${(e as Error).message}` });
      return;
    }
    // Refresh the in-memory store so the next login picks up the new
    // role set without a server restart. maybeReloadUsers stat()s the
    // file's mtime, which we just bumped via the atomic rename.
    await maybeReloadUsers();
    res.json({ ok: true, username, roles: requestedRoles });
  });

  // Upsert a role in the file-backed RBAC policy. File engine only:
  // built-in defaults are immutable in source; OPA is the Rego
  // source of truth. The UI hides the affordance under non-file
  // engines via the [data-engine-required="file"] CSS gate; the
  // endpoint enforces the rule too for defence-in-depth.
  app.put("/api/policy/roles/:name", need("users", "delete"), audit("users", "write"), async (req, res) => {
    const name = String(req.params.name);
    // Reject names with shell-unfriendly characters early so the
    // YAML round-trip can't accidentally produce an exotic key.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
      res.status(400).json({ error: `role name '${name}' must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}` });
      return;
    }
    const policyFile = process.env.OMCP_RBAC_POLICY_FILE?.trim();
    if (!policyEngine.kind().startsWith("file:")) {
      // Built-in (immutable source) or OPA (Rego is the source of
      // truth) — role authoring isn't available. Return distinct
      // error codes so the UI can show the right hint without
      // string-matching the message.
      const code = policyEngine.kind() === "builtin"
        ? "OMCP_POLICY_ENGINE_BUILTIN"
        : policyEngine.kind().startsWith("opa:")
          ? "OMCP_POLICY_ENGINE_OPA"
          : "OMCP_POLICY_ENGINE_NOT_FILE";
      res.status(409).json({
        error: `role authoring requires the file engine — current is '${policyEngine.kind()}'`,
        code,
      });
      return;
    }
    if (!policyFile) {
      res.status(409).json({
        error: "OMCP_RBAC_POLICY_FILE is not configured — role authoring writes through that file.",
        code: "OMCP_POLICY_FILE_NOT_SET",
      });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || !Array.isArray(body.permissions)) {
      res.status(400).json({ error: "body must include { permissions: [{resource, action}] }" });
      return;
    }
    const cleanPerms: Permission[] = [];
    for (let i = 0; i < body.permissions.length; i++) {
      const p = body.permissions[i] as Record<string, unknown>;
      if (!p || typeof p !== "object" || typeof p.resource !== "string" || typeof p.action !== "string") {
        res.status(400).json({ error: `body.permissions[${i}] must be { resource: string, action: string }` });
        return;
      }
      if (!VALID_RESOURCES.has(p.resource as Resource)) {
        res.status(422).json({
          error: `unknown resource '${p.resource}'`,
          code: "OMCP_POLICY_UNKNOWN_RESOURCE",
          unknown: p.resource,
          available: [...VALID_RESOURCES],
        });
        return;
      }
      if (!VALID_ACTIONS.has(p.action as Action)) {
        res.status(422).json({
          error: `unknown action '${p.action}'`,
          code: "OMCP_POLICY_UNKNOWN_ACTION",
          unknown: p.action,
          available: [...VALID_ACTIONS],
        });
        return;
      }
      cleanPerms.push({ resource: p.resource as Resource, action: p.action as Action });
    }
    // De-duplicate exact (resource, action) pairs so the file
    // doesn't accumulate redundant entries via re-saves.
    const seen = new Set<string>();
    const dedup: Permission[] = [];
    for (const p of cleanPerms) {
      const k = p.resource + ":" + p.action;
      if (seen.has(k)) continue;
      seen.add(k);
      dedup.push(p);
    }
    // Snapshot the existing map (via raw()) and overlay the upsert.
    // BuiltinPolicyEngine is the only kind that reaches here per the
    // checks above.
    const current: Record<string, Permission[]> = {};
    if (policyEngine instanceof BuiltinPolicyEngine) {
      for (const [r, ps] of Object.entries(policyEngine.raw())) {
        current[r] = ps.slice();
      }
    }
    current[name] = dedup;
    try {
      await writePolicyFile(policyFile, current);
    } catch (e) {
      if (e instanceof PolicyLoadError) {
        res.status(422).json({ error: e.message });
        return;
      }
      res.status(500).json({ error: `failed to persist policy: ${(e as Error).message}` });
      return;
    }
    // Hot-swap the in-memory engine so the next gate evaluation
    // picks up the new role without a restart. `replace()` mutates
    // in-place, so existing middleware closures over `policyEngine`
    // see the new map immediately.
    if (policyEngine instanceof BuiltinPolicyEngine) {
      const fresh = loadPolicyFromFile(policyFile);
      if (fresh instanceof BuiltinPolicyEngine) {
        policyEngine.replace(fresh.raw());
      }
    }
    res.json({ ok: true, name, permissions: dedup });
  });

  // --- /api/audit — management-plane audit feed -------------------------
  // Read-only, gated by the "audit:read" permission so only viewers /
  // operators / admins (basically anyone authenticated in the default
  // policy) can pull it. Supports optional ?from, ?to (RFC-3339), ?actor,
  // ?action, ?limit (default 100, capped to ring size).
  app.get("/api/audit", need("audit", "read"), (req, res) => {
    // Tenant scoping: a non-admin caller (no `users:delete`) sees
    // only their own tenant's entries. Admins see everything by
    // default but can ?tenant=acme to filter. This avoids leaking
    // other tenants' actor / target / path bytes through the audit
    // surface — the chain-hash protected ground truth is still
    // process-wide; the API view is per-tenant.
    const sess = (req as AuthedRequest).session;
    const isAdmin = hasPermission(sess?.roles, "users", "delete");
    const callerTenant = sess?.tenant || "default";
    const requestedTenant = qstr(req.query.tenant);
    const tenantFilter = isAdmin ? requestedTenant : callerTenant;
    const entries = mgmtAudit.list({
      from: qstr(req.query.from),
      to: qstr(req.query.to),
      actor: qstr(req.query.actor),
      action: qstr(req.query.action),
      tenant: tenantFilter || undefined,
      limit: qstr(req.query.limit) ? parseInt(qstr(req.query.limit)!, 10) : undefined,
    });
    res.json({
      entries,
      tipHash: mgmtAudit.tipHash,
      persisted: !!process.env.OMCP_MGMT_AUDIT_FILE,
      // Tell the UI which tenant scope the view is currently showing
      // so a cross-tenant admin sees an explicit "(all tenants)" hint.
      scopedTo: tenantFilter || (isAdmin ? null : callerTenant),
    });
  });

  // --- /api/usage — per-identity MCP rate-limit snapshot -----------------
  // Read-only view of the IdentityRateLimiter's bucket state. Gated by
  // need("audit","read") — the same role set that already sees the
  // audit log can see who is calling what. Anonymous /mcp traffic
  // never enters a bucket so it doesn't show up here.
  app.get("/api/usage", need("audit", "read"), (req, res) => {
    const sess = (req as AuthedRequest).session;
    const isAdmin = hasPermission(sess?.roles, "users", "delete");
    const callerTenant = sess?.tenant || "default";
    const requestedTenant = qstr(req.query.tenant);
    const tenantFilter = isAdmin ? requestedTenant : callerTenant;
    const actorFilter = qstr(req.query.actor);
    // Union of identities known to either tracker. The tracker keys
    // are composite "<tenant> <name>"; we split them back out for the
    // response shape so the UI sees clean tenant + actor columns.
    const idSet = new Set<string>([
      ...toolRateLimiter.knownIdentities(),
      ...tokenBudget.knownIdentities(),
    ]);
    const now = Date.now();
    const identities = [...idSet]
      .map((id) => {
        const split = splitIdentityKey(id);
        if (tenantFilter && split.tenant !== tenantFilter) return null;
        if (actorFilter && split.actor !== actorFilter) return null;
        const r = toolRateLimiter.inspect(id, now);
        const b = tokenBudget.inspect(id, now);
        return {
          actor: split.actor,
          tenant: split.tenant,
          count: r.count,
          limit: r.limit,
          windowMs: r.windowMs,
          tokens: { used: b.used, limit: b.limit, windowMs: b.windowMs },
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    res.json({
      identities,
      defaultLimit: resolveToolRatePerMin(process.env.OMCP_TOOL_RATE_PER_MIN),
      windowMs: 60_000,
      tokens: {
        defaultLimit: resolveDailyTokenLimit(process.env.OMCP_TOOL_DAILY_TOKENS),
        windowMs: 24 * 60 * 60 * 1000,
      },
      // Same scoping breadcrumb /api/audit returns: which tenant
      // window the response is showing. null = "all tenants" (admin).
      scopedTo: tenantFilter || (isAdmin ? null : callerTenant),
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
      { sub: user.username, name: user.name, roles: user.roles, tenant: user.tenant },
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
    if (authRuntime.mode === "anonymous" || !sessionCfg) {
      res.status(204).end();
      return;
    }
    const secure = req.secure || (req.headers["x-forwarded-proto"] === "https");
    res.setHeader("Set-Cookie", clearCookieHeader(sessionCfg, { secure }));
    res.status(204).end();
  });

  // OIDC code-flow endpoints (login redirect, callback, logout) — only
  // mounted when OMCP_AUTH=oidc resolved cleanly. registerOidcRoutes is
  // a no-op at the type level when oidcRuntime is undefined; we guard
  // here so we don't even define the routes in basic/anonymous mode.
  if (authRuntime.mode === "oidc" && oidcRuntime && sessionCfg) {
    registerOidcRoutes(app, { sessionCfg, oidc: oidcRuntime });
    console.log("[auth] OIDC endpoints registered: /api/auth/oidc/{login,callback,logout}");
  }

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

  // Add a new source — tenant-aware. Non-admins can only create
  // sources in their own tenant; admins may set any tenant or leave
  // unset (global). Untagged inputs default to undefined (global) for
  // admins and to the caller's own tenant for non-admins, so a
  // tenant-bound user can't accidentally pollute the global pool.
  app.post("/api/sources", installRateLimit, need("sources","write"), audit("sources","write"), async (req, res) => {
    const { name, type, url, enabled, auth, tls, tenant: bodyTenant } = req.body;
    if (!name || !type || !url) {
      res.status(400).json({ error: "name, type, and url are required" });
      return;
    }
    const urlErr = validateSourceUrl(url);
    if (urlErr) { res.status(400).json({ error: urlErr }); return; }
    const sess = (req as AuthedRequest).session;
    const isAdmin = hasPermission(sess?.roles, "users", "delete");
    const callerTenant = sess?.tenant || "default";
    const resolvedTenant: string | undefined = isAdmin
      ? (typeof bodyTenant === "string" && bodyTenant ? bodyTenant : undefined)
      : (typeof bodyTenant === "string" && bodyTenant && bodyTenant !== callerTenant
          ? "__deny__"
          : callerTenant);
    if (resolvedTenant === "__deny__") {
      res.status(403).json({ error: "cannot create source in another tenant" });
      return;
    }
    const existing = registry.getSourceConfigs().find((s) => s.name === name);
    if (existing) {
      res.status(409).json({ error: `Source "${name}" already exists` });
      return;
    }
    const source = { name, type, url, enabled: enabled !== false, auth, tls, tenant: resolvedTenant };
    await registry.addSource(source);
    saveConfig(config = { ...config, sources: registry.getSourceConfigs() });
    res.status(201).json({ ok: true, source });
  });

  // Update an existing source — tenant-aware. Non-admins editing a
  // cross-tenant source get the same 404 they'd get for "no such
  // source" (no existence leak). Admins may move a source between
  // tenants by setting body.tenant; non-admins cannot.
  app.put("/api/sources/:name", need("sources","write"), audit("sources","write"), async (req, res) => {
    const oldName = String(req.params.name);
    const { name, type, url, enabled, auth, tls, tenant: bodyTenant } = req.body;
    const existing = registry.getSourceConfigs().find((s) => s.name === oldName);
    const sess = (req as AuthedRequest).session;
    const isAdmin = hasPermission(sess?.roles, "users", "delete");
    const callerTenant = sess?.tenant || "default";
    if (!existing || (!isAdmin && existing.tenant && existing.tenant !== callerTenant)) {
      res.status(404).json({ error: `Source "${oldName}" not found` });
      return;
    }
    const newUrl = url || existing.url;
    if (url) {
      const urlErr = validateSourceUrl(newUrl);
      if (urlErr) { res.status(400).json({ error: urlErr }); return; }
    }
    let nextTenant = existing.tenant;
    if (bodyTenant !== undefined) {
      if (!isAdmin) {
        // Non-admin attempting tenant reassignment — disallow.
        if (bodyTenant !== existing.tenant) {
          res.status(403).json({ error: "cannot change source tenant" });
          return;
        }
      } else {
        nextTenant = typeof bodyTenant === "string" && bodyTenant ? bodyTenant : undefined;
      }
    }
    const source = {
      name: name || oldName,
      type: type || existing.type,
      url: newUrl,
      enabled: enabled !== undefined ? enabled : existing.enabled,
      auth: auth !== undefined ? auth : existing.auth,
      tls: tls !== undefined ? tls : existing.tls,
      tenant: nextTenant,
    };
    await registry.updateSource(oldName, source);
    saveConfig(config = { ...config, sources: registry.getSourceConfigs() });
    res.json({ ok: true, source });
  });

  // Delete a source — same cross-tenant 404 posture.
  app.delete("/api/sources/:name", need("sources","delete"), audit("sources","delete"), async (req, res) => {
    const name = String(req.params.name);
    const existing = registry.getSourceConfigs().find((s) => s.name === name);
    const sess = (req as AuthedRequest).session;
    const isAdmin = hasPermission(sess?.roles, "users", "delete");
    const callerTenant = sess?.tenant || "default";
    if (!existing || (!isAdmin && existing.tenant && existing.tenant !== callerTenant)) {
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
    const sess = (req as AuthedRequest).session;
    const isAdmin = hasPermission(sess?.roles, "users", "delete");
    const callerTenant = sess?.tenant || "default";
    if (!existing || (!isAdmin && existing.tenant && existing.tenant !== callerTenant)) {
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
  app.get("/api/services", async (req, res) => {
    try {
      const sess = (req as AuthedRequest).session;
      const callerTenant = sess?.tenant || "default";
      // sessionContext threads the caller's tenant into the handler so
      // PR #331's per-tenant connector scoping fires for the dashboard
      // surface too (was previously bypassed with defaultContext()).
      const result = await listServicesHandler(registry, {}, sessionContext(sess));
      const parsed = parseToolResult(result) as { services?: Array<Record<string, unknown> & { name?: string }> };
      // Tenant-scope catalog enrichment so a viewer in tenant A
      // doesn't accidentally see acme's owner/SLO metadata on a
      // service that happens to share a name. Anonymous mode is
      // session-less so callerTenant is "default" → matches
      // entries with no tenant field too (pre-E7 behaviour).
      if (parsed?.services) {
        for (const s of parsed.services) {
          const entry = typeof s.name === "string" ? catalog.get(s.name, callerTenant) : undefined;
          if (entry) s.catalog = entry;
        }
      }
      res.json(parsed);
    } catch { res.status(500).json({ error: "Failed to list services" }); }
  });

  // Read-only view of the configured catalog. Gated by the same
  // "catalog:read" permission Phase E4 added to DEFAULT_POLICY.
  app.get("/api/catalog", need("catalog", "read"), (req, res) => {
    // Same scoping shape as /api/audit + /api/usage: non-admins see
    // only their own tenant's catalog entries; admins see all by
    // default and can ?tenant=X for an explicit drill-down.
    const sess = (req as AuthedRequest).session;
    const isAdmin = hasPermission(sess?.roles, "users", "delete");
    const callerTenant = sess?.tenant || "default";
    const requestedTenant = qstr(req.query.tenant);
    const tenantFilter = isAdmin ? requestedTenant : callerTenant;
    const services = catalog.list(tenantFilter || undefined);
    res.json({
      services,
      count: Object.keys(services).length,
      configured: !!process.env.OMCP_SERVICE_CATALOG_FILE,
      scopedTo: tenantFilter || (isAdmin ? null : callerTenant),
    });
  });

  // --- /api/products — MCP Products catalogue ---------------------------
  // Same scoping / staging-visibility pattern as /api/catalog. Non-admins
  // see only their own tenant's PUBLISHED products; admins see all
  // tenants by default + staging.
  app.get("/api/products", need("products", "read"), async (req, res) => {
    // Pick up out-of-band edits before serving — see ProductsStore docs.
    await products.maybeReload();
    const sess = (req as AuthedRequest).session;
    const isAdmin = hasPermission(sess?.roles, "users", "delete");
    const callerTenant = sess?.tenant || "default";
    const requestedTenant = qstr(req.query.tenant);
    const tenantFilter = isAdmin ? requestedTenant : callerTenant;
    const includeStaging = isAdmin;
    res.json({
      products: products.list({ tenant: tenantFilter || undefined, includeStaging }),
      configured: !!process.env.OMCP_PRODUCTS_FILE,
      scopedTo: tenantFilter || (isAdmin ? null : callerTenant),
      includesStaging: includeStaging,
    });
  });
  // Create a new product (REST convention: POST = create, 409 on
  // conflict). Same tenancy + typo-guard posture as PUT. The PUT
  // upsert path remains for the existing UI; new integrations that
  // want strict create-vs-update semantics use POST.
  app.post("/api/products", need("products", "write"), audit("products", "write"), async (req, res) => {
    await products.maybeReload();
    const sess = (req as AuthedRequest).session;
    const isAdmin = hasPermission(sess?.roles, "users", "delete");
    const callerTenant = sess?.tenant || "default";
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ error: "body must be a product object" });
      return;
    }
    if (typeof body.id !== "string" || !body.id) {
      res.status(400).json({ error: "body.id is required" });
      return;
    }
    let validated;
    try { validated = validateProduct(body, `POST /api/products`); }
    catch (e) {
      if (e instanceof ProductsLoadError) { res.status(400).json({ error: e.message }); return; }
      throw e;
    }
    if (validated.tools && validated.tools.length > 0) {
      const unknown = unknownToolNames(validated.tools);
      if (unknown.length > 0) {
        res.status(422).json({
          error: `unknown tool name(s) in product '${validated.id}': ${unknown.join(", ")}`,
          code: "OMCP_PRODUCT_UNKNOWN_TOOL",
          unknown,
          available: REGISTERED_TOOL_NAMES,
        });
        return;
      }
    }
    if (!isAdmin && (validated.tenant || "default") !== callerTenant) {
      res.status(403).json({ error: "cannot create product in another tenant" });
      return;
    }
    if (products.get(validated.id)) {
      res.status(409).json({ error: `product '${validated.id}' already exists; use PUT to update` });
      return;
    }
    const next = products.upsert(validated);
    if (process.env.OMCP_PRODUCTS_FILE) {
      try {
        await writeProductsFile(process.env.OMCP_PRODUCTS_FILE, next);
        await products.pinMtimeAfterWrite();
      }
      catch (e) {
        console.warn(`[products] POST ${validated.id}: failed to persist to ${process.env.OMCP_PRODUCTS_FILE}: ${(e as Error).message} — in-memory state is still updated`);
      }
    }
    res.status(201).json({ product: validated, persisted: !!process.env.OMCP_PRODUCTS_FILE });
  });

  // Upsert a product. Body is the same shape as a single entry
  // in OMCP_PRODUCTS_FILE. The URL-path id must match the body id
  // (defence-in-depth: the gate keys on body, the path keys the
  // audit entry). When OMCP_PRODUCTS_FILE is set we also write the
  // updated catalogue back to disk so the change survives a
  // restart; without the file, the upsert is in-memory only.
  app.put("/api/products/:id", need("products", "write"), audit("products", "write"), async (req, res) => {
    // Hot-reload before mutating so a concurrent on-disk edit isn't
    // silently clobbered by our in-memory snapshot.
    await products.maybeReload();
    const id = String(req.params.id);
    const sess = (req as AuthedRequest).session;
    const isAdmin = hasPermission(sess?.roles, "users", "delete");
    const callerTenant = sess?.tenant || "default";
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ error: "body must be a product object" });
      return;
    }
    if (typeof body.id === "string" && body.id !== id) {
      res.status(400).json({ error: `body.id '${body.id}' does not match URL path '${id}'` });
      return;
    }
    // Force the id from the URL so the audit entry's target matches
    // the persisted record even if the operator omitted it from the
    // body.
    const payload = { ...body, id };
    let validated;
    try { validated = validateProduct(payload, `PUT /api/products/${id}`); }
    catch (e) {
      if (e instanceof ProductsLoadError) { res.status(400).json({ error: e.message }); return; }
      throw e;
    }
    // Typo guard: a Product whose `tools` allow-list names tools
    // that don't actually register would bind a credential to an
    // empty /mcp tool surface (silent dead session). Reject with
    // 422 + a hint of valid tool names so the operator can see the
    // intended typo immediately.
    if (validated.tools && validated.tools.length > 0) {
      const unknown = unknownToolNames(validated.tools);
      if (unknown.length > 0) {
        res.status(422).json({
          error: `unknown tool name(s) in product '${id}': ${unknown.join(", ")}`,
          code: "OMCP_PRODUCT_UNKNOWN_TOOL",
          unknown,
          available: REGISTERED_TOOL_NAMES,
        });
        return;
      }
    }
    // Tenant gate: non-admins can only write into their own tenant.
    if (!isAdmin && (validated.tenant || "default") !== callerTenant) {
      res.status(403).json({ error: "cannot write product into another tenant" });
      return;
    }
    // If an existing product belongs to a different tenant, a non-
    // admin overwrite would re-parent it — same 404-not-403 posture
    // as cross-tenant gets.
    const existing = products.get(id);
    if (existing && !isAdmin && (existing.tenant || "default") !== callerTenant) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const next = products.upsert(validated);
    if (process.env.OMCP_PRODUCTS_FILE) {
      try {
        await writeProductsFile(process.env.OMCP_PRODUCTS_FILE, next);
        // Advance our mtime cursor past this write so the next
        // maybeReload() doesn't treat our own change as an external
        // edit and re-read what we just persisted.
        await products.pinMtimeAfterWrite();
      }
      catch (e) {
        console.warn(`[products] PUT ${id}: failed to persist to ${process.env.OMCP_PRODUCTS_FILE}: ${(e as Error).message} — in-memory state is still updated`);
      }
    }
    res.json({ product: validated, persisted: !!process.env.OMCP_PRODUCTS_FILE });
  });
  app.delete("/api/products/:id", need("products", "delete"), audit("products", "delete"), async (req, res) => {
    await products.maybeReload();
    const id = String(req.params.id);
    const sess = (req as AuthedRequest).session;
    const isAdmin = hasPermission(sess?.roles, "users", "delete");
    const callerTenant = sess?.tenant || "default";
    const existing = products.get(id);
    if (!existing) { res.status(404).json({ error: "not found" }); return; }
    if (!isAdmin && (existing.tenant || "default") !== callerTenant) {
      res.status(404).json({ error: "not found" }); return;
    }
    const { file: next } = products.delete(id);
    if (process.env.OMCP_PRODUCTS_FILE) {
      try {
        await writeProductsFile(process.env.OMCP_PRODUCTS_FILE, next);
        await products.pinMtimeAfterWrite();
      }
      catch (e) {
        console.warn(`[products] DELETE ${id}: failed to persist to ${process.env.OMCP_PRODUCTS_FILE}: ${(e as Error).message} — in-memory state is still updated`);
      }
    }
    res.status(204).end();
  });
  // Single product by id. Non-admins get a 404 (not 403) on a
  // cross-tenant probe so the existence of the product isn't leaked
  // — same posture as the rest of the tenancy layer.
  app.get("/api/products/:id", need("products", "read"), async (req, res) => {
    await products.maybeReload();
    const sess = (req as AuthedRequest).session;
    const isAdmin = hasPermission(sess?.roles, "users", "delete");
    const callerTenant = sess?.tenant || "default";
    const tenantFilter = isAdmin ? undefined : callerTenant;
    const id = String(req.params.id);
    const p = products.get(id, tenantFilter);
    if (!p) { res.status(404).json({ error: "not found" }); return; }
    // Non-admins also don't see staging products even if they happen
    // to belong to the same tenant.
    if (!isAdmin && p.status === "staging") { res.status(404).json({ error: "not found" }); return; }
    res.json(p);
  });

  // Agent preview — what would the /mcp tools/list response look
  // like for a credential bound to this product? Same RBAC + tenant
  // gate as the singular GET above. The body mirrors the actual
  // tools/list shape (name + description + category), filtered the
  // same way the /mcp transport filters it via allowsTool +
  // registerTool — so the UI's Review pane shows the exact set the
  // agent will see, not an approximation. Branding metadata travels
  // alongside so the preview can render with the product's identity.
  app.get("/api/products/:id/preview", need("products", "read"), async (req, res) => {
    await products.maybeReload();
    const sess = (req as AuthedRequest).session;
    const isAdmin = hasPermission(sess?.roles, "users", "delete");
    const callerTenant = sess?.tenant || "default";
    const tenantFilter = isAdmin ? undefined : callerTenant;
    const id = String(req.params.id);
    const p = products.get(id, tenantFilter);
    if (!p) { res.status(404).json({ error: "not found" }); return; }
    if (!isAdmin && p.status === "staging") { res.status(404).json({ error: "not found" }); return; }
    const allowList = p.tools && p.tools.length > 0 ? p.tools : undefined;
    const filteredTools = REGISTERED_TOOLS.filter((t) => allowsTool(allowList, t.name));
    res.json({
      product: { id: p.id, name: p.name, version: p.version, branding: p.branding, tenant: p.tenant, status: p.status },
      // unrestricted = true when the product has no tools allow-list,
      // i.e. the bound agent sees every registered tool. UI uses this
      // to render a distinct "no filter" preview banner.
      unrestricted: !allowList,
      tools: filteredTools,
    });
  });

  // Health endpoint for UI dashboard
  app.get("/api/health/:service", async (req, res) => {
    try {
      const sess = (req as AuthedRequest).session;
      const callerTenant = sess?.tenant || "default";
      const service = String(req.params.service);
      const result = await getServiceHealthHandler(registry, { service }, sessionContext(sess));
      const parsed = parseToolResult(result) as Record<string, unknown>;
      const entry = catalog.get(service, callerTenant);
      if (entry && parsed && typeof parsed === "object") parsed.catalog = entry;
      res.json(parsed);
    } catch {
      res.status(500).json({ error: "Failed to get service health" });
    }
  });

  // Health for all services
  app.get("/api/health", async (req, res) => {
    try {
      const sess = (req as AuthedRequest).session;
      const callerTenant = sess?.tenant || "default";
      const ctx = sessionContext(sess);
      const servicesResult = await listServicesHandler(registry, {}, ctx);
      const parsed = parseToolResult(servicesResult) as { services?: Array<{ name: string }> };
      const services = parsed?.services || [];
      const health: Record<string, unknown> = {};
      for (const svc of services) {
        try {
          const result = await getServiceHealthHandler(registry, { service: svc.name }, ctx);
          const h = parseToolResult(result) as Record<string, unknown>;
          // Same tenant scoping as /api/services to avoid the
          // dashboard cross-tenant catalog leak the reviewer
          // caught in slice 3.
          const entry = catalog.get(svc.name, callerTenant);
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
  app.get("/api/topology", async (req, res) => {
    try {
      const sess = (req as AuthedRequest).session;
      const callerTenant = sess?.tenant || "default";
      const sources: Array<{
        source: string;
        type: string;
        revision: number;
        resources: number;
        edges: number;
      }> = [];
      const allResources = [];
      const allEdges = [];
      // Tenant-scoped: non-anonymous callers only see topology from
      // connectors their tenant can reach. Anonymous mode keeps the
      // global view (single-tenant default).
      const connectors = sess ? registry.getByTenant(callerTenant) : registry.getAll();
      for (const c of connectors) {
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
    const name = String(req.params.name);
    const sess = (req as AuthedRequest).session;
    const isAdmin = hasPermission(sess?.roles, "users", "delete");
    const callerTenant = sess?.tenant || "default";
    // Tenant-aware: getByNameForTenant returns undefined for both
    // "doesn't exist" and "cross-tenant" — same no-leak posture as
    // /api/sources GET/PUT/DELETE. Anonymous / admin keep the
    // single-tenant behaviour by falling back to getByName.
    const connector = (sess && !isAdmin)
      ? registry.getByNameForTenant(name, callerTenant)
      : registry.getByName(name);
    if (!connector) {
      res.status(404).json({ error: `Source "${name}" not found` });
      return;
    }
    res.json({
      metrics: connector.getMetrics(),
      defaults: connector.getDefaultMetrics(),
    });
  });

  // Update metrics for a source — tenant-aware mutation.
  app.put("/api/sources/:name/metrics", need("sources","write"), audit("sources","write"), async (req, res) => {
    const name = String(req.params.name);
    const sourceIdx = config.sources.findIndex((s) => s.name === name);
    const sess = (req as AuthedRequest).session;
    const isAdmin = hasPermission(sess?.roles, "users", "delete");
    const callerTenant = sess?.tenant || "default";
    const src = sourceIdx >= 0 ? config.sources[sourceIdx] : undefined;
    if (!src || (!isAdmin && src.tenant && src.tenant !== callerTenant)) {
      res.status(404).json({ error: `Source "${name}" not found` });
      return;
    }
    config.sources[sourceIdx].metrics = req.body.metrics || [];
    // Reconnect to pick up new metrics
    await registry.updateSource(name, config.sources[sourceIdx]);
    saveConfig(config);
    res.json({ ok: true });
  });

  // Reset a source's metrics to connector defaults — tenant-aware.
  app.delete("/api/sources/:name/metrics", need("sources","write"), audit("sources","write"), async (req, res) => {
    const name = String(req.params.name);
    const sourceIdx = config.sources.findIndex((s) => s.name === name);
    const sess = (req as AuthedRequest).session;
    const isAdmin = hasPermission(sess?.roles, "users", "delete");
    const callerTenant = sess?.tenant || "default";
    const src = sourceIdx >= 0 ? config.sources[sourceIdx] : undefined;
    if (!src || (!isAdmin && src.tenant && src.tenant !== callerTenant)) {
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
  // Phase F9: per-session tag identifying the virtual-server slug a
  // session was issued under (or undefined for the root /mcp surface).
  // Used to prevent a session minted on /mcp/v/foo from being probed
  // via /mcp/v/bar — the GET/DELETE handlers refuse the cross-product
  // lookup.
  const sessionProduct = new Map<string, string | undefined>();
  const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min idle timeout

  // Clean up idle sessions every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [sid, lastActive] of sessionLastActive) {
      if (now - lastActive > SESSION_TTL_MS) {
        transports.delete(sid);
        sessionLastActive.delete(sid);
        sessionProduct.delete(sid);
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
  // Per-credential cap overrides: OMCP_KEY_RATE_PER_MIN="agent=600;ci=240"
  // wins over the global OMCP_TOOL_RATE_PER_MIN for the named credentials.
  // The bucket identity is "<tenant> <credName>"; the override map keys on
  // credName, so the lookup pulls the cred-name back out of the composite.
  const keyRateLimits = parseKeyRateLimits(process.env.OMCP_KEY_RATE_PER_MIN);
  const toolRateLimiter = new IdentityRateLimiter({
    limit: resolveToolRatePerMin(process.env.OMCP_TOOL_RATE_PER_MIN),
    limitFor: keyRateLimits.size === 0 ? undefined : (identity: string) => {
      // Composite identity is "<tenant> <credName>" — split on the
      // single space that gateCtx put there (NUL would be safer but
      // would break existing /api/usage actor labels; cred names are
      // operator-set and don't contain spaces in practice).
      const sp = identity.indexOf(" ");
      const credName = sp >= 0 ? identity.slice(sp + 1) : identity;
      return keyRateLimits.get(credName);
    },
  });
  // Per-identity tracker key. Composes tenant + principalId so two
  // credentials of the same name in different tenants don't share
  // a bucket. Surface-level fields in /api/usage are still split
  // back out (see the row builder there) so the UI shows clean
  // actor + tenant columns.
  const identityKey = (ctx: RequestContext): string =>
    `${ctx.tenant} ${ctx.principalId}`;
  function splitIdentityKey(key: string): { tenant: string; actor: string } {
    const i = key.indexOf(" ");
    if (i < 0) return { tenant: "default", actor: key };
    return { tenant: key.slice(0, i), actor: key.slice(i + 1) };
  }

  // Token-budget: per-identity 24h rolling daily cap on tokens pulled
  // through the MCP tool layer. Off by default (OMCP_TOOL_DAILY_TOKENS
  // unset/zero/negative). When configured, big-data tools
  // (query_logs / query_metrics / get_service_health) charge the
  // estimated response size against the cap; over-cap calls return a
  // structured OMCP_TOKEN_BUDGET_EXCEEDED payload instead of data.
  const tokenBudget = new TokenBudget({
    dailyLimit: resolveDailyTokenLimit(process.env.OMCP_TOOL_DAILY_TOKENS),
    filePath: process.env.OMCP_TOKEN_BUDGET_FILE?.trim() || undefined,
  });
  // AWAIT bootstrap before any tool call can arrive: a void-fired
  // bootstrap raced with /mcp requests would silently overwrite
  // post-boot charges with the on-disk snapshot when it later
  // resolved. The file is small (KB range) so the wait is
  // negligible; a missing file returns immediately.
  await tokenBudget.bootstrap();
  // Flush on graceful shutdown so the debounce-window of pending
  // charges isn't dropped on `kubectl rollout restart` etc. The
  // process keeps running while we wait — the snapshot is small.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      void tokenBudget.flushNow().catch(() => { /* best-effort */ });
    });
  }

  // Bearer/X-API-Key on every /mcp request; resolve the principal + its
  // coarse source allow-list into the RequestContext.
  async function gateCtx(
    req: import("express").Request,
    res: import("express").Response
  ): Promise<RequestContext | null> {
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
    // Composite tenant:cred-name key so two creds with the same
    // name in different tenants don't share a bucket.
    const credTenant = (cred.tenant || "default");
    const decision = toolRateLimiter.check(`${credTenant} ${cred.name}`);
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
    // Resolve the credential's bound Product (OMCP_KEY_PRODUCTS) into
    // a concrete tools allow-list. Cross-tenant Products are invisible
    // — products.get() returns undefined when the productId belongs to
    // another tenant, mirroring the rest of the tenancy layer. A bound
    // Product whose own `tools` field is absent / empty leaves the
    // allow-list undefined (== unrestricted), matching the YAML
    // loader's "no tools key = no restriction" semantics.
    let allowedTools: string[] | undefined;
    if (cred.productId) {
      // Pick up out-of-band edits to OMCP_PRODUCTS_FILE before each
      // /mcp request — cheap (one stat), keeps the binding live.
      // Best-effort: if the catalogue reload fails we keep the prior
      // good state (the store handles that internally) rather than
      // failing the request.
      await products.maybeReload().catch(() => undefined);
      const p = products.get(cred.productId, credTenant);
      if (p && p.tools && p.tools.length > 0) allowedTools = p.tools.slice();
    }
    return principalContext(cred.name, cred.allowedSources, {
      allowBypassRedaction: cred.bypassRedaction,
      tenant: cred.tenant,
      allowedTools,
    });
  }

  app.post("/mcp", async (req, res) => {
    const ctx = await gateCtx(req, res);
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
    if (!(await gateCtx(req, res))) return;
    const sessionId = req.headers["mcp-session-id"] as string;
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: "No active session" });
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    if (!(await gateCtx(req, res))) return;
    const sessionId = req.headers["mcp-session-id"] as string;
    const transport = transports.get(sessionId);
    if (transport) {
      await transport.handleRequest(req, res);
      transports.delete(sessionId);
      sessionLastActive.delete(sessionId);
      sessionProduct.delete(sessionId);
    } else {
      res.status(400).json({ error: "No active session" });
    }
  });

  // Phase F9: virtual servers — every Product gets its own MCP
  // endpoint at /mcp/v/<slug> that exposes only the tools bound to
  // that Product, with the caller's existing tenant + RBAC scoping
  // preserved. The narrow ctx flows into createMcpServer's
  // registerTool gate, so the surface a /mcp/v/<slug> client sees is
  // strictly product.tools (intersected with any pre-existing
  // allowedTools the credential already carries).
  function intersectAllowed(
    a: string[] | undefined,
    b: string[] | undefined,
  ): string[] | undefined {
    if (!a) return b;
    if (!b) return a;
    const bSet = new Set(b);
    return a.filter((t) => bSet.has(t));
  }

  async function resolveVirtualProduct(
    req: import("express").Request,
    res: import("express").Response,
    baseCtx: RequestContext,
  ): Promise<{ product: { tools?: string[]; id: string }; ctx: RequestContext } | null> {
    const slug = req.params.slug;
    if (!slug || typeof slug !== "string") {
      res.status(404).json({ error: "virtual server not found" });
      return null;
    }
    // Hot-reload aware so newly-published products are visible
    // without restart (same pattern /mcp uses for product changes).
    await products.maybeReload().catch(() => undefined);
    const tenant = baseCtx.tenant || "default";
    const product = products.get(slug, tenant);
    if (!product || product.status === "staging") {
      // 404 (not 403) for cross-tenant or missing — matches the
      // existence-hiding stance of the rest of the tenancy layer.
      res.status(404).json({ error: "virtual server not found" });
      return null;
    }
    const allowedTools = intersectAllowed(baseCtx.allowedTools, product.tools);
    const ctx: RequestContext = { ...baseCtx, allowedTools };
    return { product, ctx };
  }

  app.post("/mcp/v/:slug", async (req, res) => {
    const baseCtx = await gateCtx(req, res);
    if (!baseCtx) return;
    const resolved = await resolveVirtualProduct(req, res, baseCtx);
    if (!resolved) return;
    const { ctx, product } = resolved;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;
    if (sessionId && transports.has(sessionId)) {
      // Cross-product session probe is rejected: the session is
      // bound to whichever virtual server issued it.
      if (sessionProduct.get(sessionId) !== product.id) {
        res.status(404).json({ error: "virtual server not found" });
        return;
      }
      transport = transports.get(sessionId)!;
    } else {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      transport.onclose = () => {
        for (const [sid, t] of transports) {
          if (t === transport) {
            transports.delete(sid);
            sessionProduct.delete(sid);
            break;
          }
        }
        mcpActiveSessions.set(transports.size);
      };
      const sessionMcpServer = createMcpServer(ctx);
      await sessionMcpServer.connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
    const sid = res.getHeader("mcp-session-id") as string;
    if (sid) {
      if (!transports.has(sid)) {
        transports.set(sid, transport);
        sessionProduct.set(sid, product.id);
      }
      sessionLastActive.set(sid, Date.now());
    }
    mcpActiveSessions.set(transports.size);
  });

  app.get("/mcp/v/:slug", async (req, res) => {
    const baseCtx = await gateCtx(req, res);
    if (!baseCtx) return;
    const resolved = await resolveVirtualProduct(req, res, baseCtx);
    if (!resolved) return;
    const sessionId = req.headers["mcp-session-id"] as string;
    const transport = transports.get(sessionId);
    if (!transport || sessionProduct.get(sessionId) !== resolved.product.id) {
      res.status(400).json({ error: "No active session" });
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete("/mcp/v/:slug", async (req, res) => {
    const baseCtx = await gateCtx(req, res);
    if (!baseCtx) return;
    const resolved = await resolveVirtualProduct(req, res, baseCtx);
    if (!resolved) return;
    const sessionId = req.headers["mcp-session-id"] as string;
    const transport = transports.get(sessionId);
    if (transport && sessionProduct.get(sessionId) === resolved.product.id) {
      await transport.handleRequest(req, res);
      transports.delete(sessionId);
      sessionLastActive.delete(sessionId);
      sessionProduct.delete(sessionId);
    } else {
      res.status(400).json({ error: "No active session" });
    }
  });

  // Bearer-token resolver for WebSocket upgrade requests. Browsers
  // can't set Authorization on a WS handshake, so we accept the token
  // from any of: Authorization: Bearer X, ?token=X, or the
  // Sec-WebSocket-Protocol subprotocol "bearer.X" (echoed back by the
  // server when accepted so clients see which subprotocol won).
  function extractWsToken(req: import("http").IncomingMessage): {
    token?: string;
    selectedSubprotocol?: string;
  } {
    const auth = req.headers["authorization"];
    if (typeof auth === "string") {
      const m = auth.match(/^Bearer\s+(.+)$/i);
      if (m) return { token: m[1] };
    }
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const q = url.searchParams.get("token");
      if (q) return { token: q };
    } catch {
      /* malformed URL */
    }
    const sp = req.headers["sec-websocket-protocol"];
    if (typeof sp === "string") {
      const offered = sp.split(",").map((s) => s.trim());
      const bearer = offered.find((p) => p.startsWith("bearer."));
      if (bearer) return { token: bearer.slice("bearer.".length), selectedSubprotocol: bearer };
    }
    return {};
  }

  async function gateWsCtx(
    req: import("http").IncomingMessage,
  ): Promise<{ ctx: RequestContext; selectedSubprotocol?: string } | { reject: number; reason: string }> {
    const { token, selectedSubprotocol } = extractWsToken(req);
    if (!credentialsConfigured()) {
      return { ctx: defaultContext(), selectedSubprotocol };
    }
    if (!token) {
      return { reject: 4401, reason: "unauthorized: token required" };
    }
    const cred = resolveToken(token, loadCredentials());
    if (!cred) {
      return { reject: 4401, reason: "unauthorized: invalid token" };
    }
    const credTenant = cred.tenant || "default";
    const decision = toolRateLimiter.check(`${credTenant} ${cred.name}`);
    if (!decision.allowed) {
      return { reject: 4429, reason: "rate limit exceeded for identity" };
    }
    let allowedTools: string[] | undefined;
    if (cred.productId) {
      await products.maybeReload().catch(() => undefined);
      const p = products.get(cred.productId, credTenant);
      if (p && p.tools && p.tools.length > 0) allowedTools = p.tools.slice();
    }
    return {
      ctx: principalContext(cred.name, cred.allowedSources, {
        allowBypassRedaction: cred.bypassRedaction,
        tenant: cred.tenant,
        allowedTools,
      }),
      selectedSubprotocol,
    };
  }

  const PORT = parseInt(process.env.PORT || "3000");
  const httpServer = app.listen(PORT, () => {
    ready = true;
    console.log(`observability-mcp server running on port ${PORT}`);
    console.log(`  MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log(`  MCP (WS):     ws://localhost:${PORT}/mcp/ws`);
    console.log(`  Web UI: http://localhost:${PORT}`);
    console.log(`  Connectors: ${registry.getAll().map((c) => c.name).join(", ")}`);
  });

  // Mount the WebSocket MCP transport. One McpServer instance per
  // accepted socket; per-connection state is carried in
  // WebSocketServerTransport.sessionId so concurrent clients stay
  // isolated. Dynamic import so the `ws` package only loads on
  // platforms that actually use this transport.
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", async (req, socket, head) => {
    if (!req.url) {
      socket.destroy();
      return;
    }
    const path = req.url.split("?")[0];
    if (path !== "/mcp/ws") {
      socket.destroy();
      return;
    }
    const auth = await gateWsCtx(req);
    if ("reject" in auth) {
      // Custom 4xxx codes during upgrade aren't expressible via HTTP
      // status, so we accept the upgrade just long enough to close
      // with the WS-level close code that carries our reason.
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(auth.reject === 4429 ? 1013 : 1008, auth.reason);
      });
      return;
    }
    wss.handleUpgrade(req, socket, head, async (ws) => {
      try {
        const transport = new WebSocketServerTransport(ws);
        const sessionMcpServer = createMcpServer(auth.ctx);
        await sessionMcpServer.connect(transport);
      } catch (err) {
        console.warn("WS /mcp/ws session setup failed:", err);
        try {
          ws.close(1011, "server error");
        } catch {
          /* socket already gone */
        }
      }
    });
  });
}

main().catch(console.error);
