// Hand-written OpenAPI 3.1 spec for the /api/* surface served by
// mcp-server. The /mcp endpoint follows the MCP Streamable HTTP spec
// (https://spec.modelcontextprotocol.io/) and is intentionally NOT
// described here; clients should use the MCP `tools/list` to discover
// the seven tools exposed there.
//
// Keep this lean — operators import it into Insomnia/Postman/OpenAPI
// codegens. If a path is missing it just won't appear in their UI.

import type { OpenAPIV3_1 } from "openapi-types";

const SOURCE_SCHEMA: OpenAPIV3_1.SchemaObject = {
  type: "object",
  required: ["name", "type", "url"],
  properties: {
    name: { type: "string", description: "Unique source name." },
    type: { type: "string", description: "Connector type id, e.g. 'prometheus'." },
    url: { type: "string", format: "uri" },
    enabled: { type: "boolean", default: true },
    auth: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["none", "basic", "bearer"] },
      },
      additionalProperties: true,
    },
    tls: { type: "object", additionalProperties: true },
    signalType: { type: "string", enum: ["metrics", "logs", "traces"] },
  },
  additionalProperties: true,
};

export function buildOpenApiSpec(version: string): OpenAPIV3_1.Document {
  // openapi-types' deeply-nested generics make literal path objects fail
  // structural assignability even when the document is valid OpenAPI. We
  // build it as a permissive object and cast at the boundary — the shape
  // is hand-verified and rendered by Swagger/Insomnia downstream.
  const doc = {
    openapi: "3.1.0",
    info: {
      title: "observability-mcp HTTP API",
      version,
      description:
        "Operator-facing REST API used by the Web UI. The MCP protocol surface lives at /mcp (Streamable HTTP) and is not described here — use MCP's tools/list to discover those.",
      contact: {
        name: "observability-mcp",
        url: "https://github.com/ThoTischner/observability-mcp",
      },
      license: { name: "MIT" },
    },
    servers: [{ url: "/", description: "Current server" }],
    tags: [
      { name: "sources", description: "Observability backend configuration." },
      { name: "services", description: "Service discovery across all backends." },
      { name: "health", description: "Aggregated health for discovered services." },
      { name: "settings", description: "Runtime server configuration." },
      { name: "metrics-config", description: "Per-source metric definitions." },
      { name: "self", description: "Server liveness and Prometheus metrics." },
      { name: "auth", description: "Management-plane session login / logout / identity." },
      { name: "audit", description: "Tamper-evident audit log of /api/* mutations." },
      { name: "usage", description: "Per-identity rate-limit snapshot for /mcp callers." },
      { name: "catalog", description: "Operator-curated service catalog." },
    ],
    paths: {
      "/api/sources": {
        get: {
          tags: ["sources"],
          summary: "List configured sources with live health.",
          responses: {
            "200": {
              description: "Sources with status, latency, signal type.",
              content: { "application/json": { schema: { type: "array", items: SOURCE_SCHEMA } } },
            },
          },
        },
        post: {
          tags: ["sources"],
          summary: "Add a new source.",
          requestBody: { required: true, content: { "application/json": { schema: SOURCE_SCHEMA } } },
          responses: {
            "201": { description: "Source created." },
            "400": { description: "Validation error." },
            "409": { description: "Source with that name already exists." },
          },
        },
      },
      "/api/sources/test": {
        post: {
          tags: ["sources"],
          summary: "Connection check against a source config without persisting it.",
          requestBody: { required: true, content: { "application/json": { schema: SOURCE_SCHEMA } } },
          responses: {
            "200": {
              description: "Reachability report.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string", enum: ["up", "down"] },
                      latencyMs: { type: "number" },
                      message: { type: "string", nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/sources/{name}": {
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        put: {
          tags: ["sources"],
          summary: "Replace an existing source.",
          requestBody: { required: true, content: { "application/json": { schema: SOURCE_SCHEMA } } },
          responses: { "200": { description: "Updated." }, "404": { description: "Not found." } },
        },
        delete: {
          tags: ["sources"],
          summary: "Remove a source.",
          responses: { "204": { description: "Removed." }, "404": { description: "Not found." } },
        },
      },
      "/api/source-types": {
        get: {
          tags: ["sources"],
          summary: "List connector type ids the server can load (builtin + filesystem plugins).",
          responses: {
            "200": {
              description: "Connector type ids.",
              content: { "application/json": { schema: { type: "array", items: { type: "string" } } } },
            },
          },
        },
      },
      "/api/services": {
        get: {
          tags: ["services"],
          summary: "List services discovered across all connected backends.",
          responses: { "200": { description: "Services." } },
        },
      },
      "/api/health": {
        get: {
          tags: ["health"],
          summary: "Aggregated health map: { [service]: ServiceHealth }.",
          responses: { "200": { description: "Health map." } },
        },
      },
      "/api/health/{service}": {
        parameters: [{ name: "service", in: "path", required: true, schema: { type: "string" } }],
        get: {
          tags: ["health"],
          summary: "Aggregated health for one service.",
          responses: { "200": { description: "ServiceHealth." }, "404": { description: "Not found." } },
        },
      },
      "/api/settings": {
        get: { tags: ["settings"], summary: "Get runtime settings.", responses: { "200": { description: "Settings." } } },
        put: { tags: ["settings"], summary: "Update runtime settings.", responses: { "200": { description: "Updated." } } },
      },
      "/api/health-thresholds": {
        get: { tags: ["settings"], summary: "Get health-score thresholds.", responses: { "200": { description: "Thresholds." } } },
        put: { tags: ["settings"], summary: "Update health-score thresholds.", responses: { "200": { description: "Updated." } } },
      },
      "/api/sources/{name}/metrics": {
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        get: { tags: ["metrics-config"], summary: "Get the active metrics list for this source.", responses: { "200": { description: "Metrics." } } },
        put: { tags: ["metrics-config"], summary: "Replace the active metrics list.", responses: { "200": { description: "Updated." } } },
        delete: { tags: ["metrics-config"], summary: "Reset to connector defaults.", responses: { "200": { description: "Reset." } } },
      },
      "/metrics": {
        get: {
          tags: ["self"],
          summary: "Prometheus scrape endpoint. Toggle with METRICS_ENABLED=false.",
          responses: {
            "200": {
              description: "OpenMetrics text exposition.",
              content: { "text/plain": { schema: { type: "string" } } },
            },
          },
        },
      },
      "/api/openapi.json": {
        get: {
          tags: ["self"],
          summary: "This document.",
          responses: { "200": { description: "OpenAPI 3.1 document." } },
        },
      },
      "/api/info": {
        get: {
          tags: ["self"],
          summary: "Server identity, build info, plugin list and governance posture.",
          description:
            "Anonymous-readable snapshot for external dashboards and discovery probes. " +
            "The `governance` block surfaces the active management-plane configuration " +
            "as booleans / rate-limit number only — no file paths, no session secret, " +
            "no user counts. Useful for alerting on \"this deployment silently reverted " +
            "to anonymous mode\" or \"redaction is off in prod\".",
          responses: {
            "200": {
              description: "Server info + governance posture.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      version: { type: "string" },
                      mcpProtocolVersion: { type: "string" },
                      build: {
                        type: "object",
                        properties: {
                          commit: { type: ["string", "null"] },
                          date: { type: ["string", "null"] },
                        },
                      },
                      runtime: {
                        type: "object",
                        properties: {
                          node: { type: "string" },
                          platform: { type: "string" },
                          arch: { type: "string" },
                        },
                      },
                      governance: {
                        type: "object",
                        description: "Active management-plane posture; booleans + rate-limit number only.",
                        properties: {
                          authMode: { type: "string", enum: ["anonymous", "basic", "oidc"] },
                          authSecretEphemeral: {
                            type: "boolean",
                            description: "True when OMCP_SESSION_SECRET is unset and the server minted an in-memory secret at boot. Sessions don't survive a restart.",
                          },
                          oidcIssuer: {
                            type: "string",
                            description: "Active OIDC issuer URL. Empty string when authMode is not 'oidc'. Never includes the client_secret.",
                          },
                          auditPersisted: {
                            type: "boolean",
                            description: "True when OMCP_MGMT_AUDIT_FILE is set; false means the audit log is the in-memory 500-entry ring.",
                          },
                          catalogConfigured: { type: "boolean" },
                          redaction: { type: "boolean" },
                          trustProxy: { type: "boolean" },
                          toolRatePerMin: { type: "integer" },
                        },
                      },
                      plugins: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            name: { type: "string" },
                            source: { type: "string" },
                            version: { type: ["string", "null"] },
                            signalTypes: { type: ["array", "null"], items: { type: "string" } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/me": {
        get: {
          tags: ["auth"],
          summary: "Current identity, mode and granted permissions.",
          responses: {
            "200": {
              description: "Identity snapshot. `authenticated: false` in anonymous mode or when the session cookie is missing/invalid.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      authenticated: { type: "boolean" },
                      mode: { type: "string", enum: ["anonymous", "basic", "oidc"] },
                      user: {
                        type: "object",
                        properties: {
                          sub: { type: "string" },
                          name: { type: "string" },
                          email: { type: "string", description: "Present when the IdP supplied a verified email claim (OIDC mode)." },
                          roles: { type: "array", items: { type: "string" } },
                        },
                      },
                      permissions: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            resource: { type: "string" },
                            action: { type: "string", enum: ["read", "write", "delete", "bypass"] },
                            // Resource enum is unconstrained at the OpenAPI level so
                            // custom policies loaded via OMCP_RBAC_POLICY_FILE that
                            // (correctly) include all built-in resources still validate.
                          },
                        },
                      },
                      exp: { type: "integer", description: "Cookie expiry (seconds since epoch)." },
                      idpIssuer: {
                        type: "string",
                        description: "Active OIDC issuer URL. Present only when mode === \"oidc\". Useful for UI badges or IdP-side profile links.",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/auth/login": {
        post: {
          tags: ["auth"],
          summary: "Sign in (basic mode only).",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["username", "password"],
                  properties: {
                    username: { type: "string" },
                    password: { type: "string", format: "password" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Set-Cookie carries the signed session." },
            "400": { description: "Missing username or password." },
            "401": { description: "Invalid credentials." },
            "429": { description: "Too many login attempts." },
            "503": { description: "Server is in anonymous mode and does not accept logins." },
          },
        },
      },
      "/api/auth/logout": {
        post: {
          tags: ["auth"],
          summary: "Sign out — clears the session cookie.",
          responses: { "204": { description: "Cookie cleared." } },
        },
      },
      "/api/auth/oidc/login": {
        get: {
          tags: ["auth"],
          summary: "Redirect to the configured OIDC identity provider's authorization endpoint.",
          description:
            "Mounted only when OMCP_AUTH=oidc. Mints a short-lived flow cookie carrying state + nonce + PKCE code-verifier + return_to, then 302s the browser to the IdP.",
          parameters: [
            { name: "return_to", in: "query", required: false, schema: { type: "string" }, description: "Same-origin path to redirect to after a successful callback. Absolute URLs or scheme-relative paths are rejected." },
          ],
          responses: {
            "302": { description: "Redirect to the IdP authorize_endpoint." },
            "502": { description: "OIDC discovery failed (IdP unreachable / misconfigured)." },
          },
        },
      },
      "/api/auth/oidc/callback": {
        get: {
          tags: ["auth"],
          summary: "OIDC code-flow callback — exchanges code for an id_token and mints an OMCP session cookie.",
          description:
            "Verifies the state cookie, the IdP-returned state, the id_token signature (RS256/ES256), iss/aud/exp/nbf/nonce claims, then resolves OMCP roles from OMCP_OIDC_ROLES_CLAIM via OMCP_OIDC_ROLE_MAP and 302s to the cookie's return_to.",
          parameters: [
            { name: "code", in: "query", schema: { type: "string" } },
            { name: "state", in: "query", schema: { type: "string" } },
            { name: "error", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: {
            "302": { description: "Authentication succeeded; session cookie set and redirected to return_to." },
            "400": { description: "Bad / expired / missing flow cookie, IdP error parameter present, or token exchange / verification failed." },
          },
        },
      },
      "/api/auth/oidc/logout": {
        post: {
          tags: ["auth"],
          summary: "Sign out of the OMCP session. Does not perform RP-initiated logout against the IdP.",
          description:
            "Clears the OMCP session cookie. To force an IdP-side sign-out, the UI should subsequently navigate to OMCP_OIDC_LOGOUT_REDIRECT (typically the IdP's end_session_endpoint).",
          responses: { "204": { description: "Cookie cleared." } },
        },
      },
      "/api/audit": {
        get: {
          tags: ["audit"],
          summary: "Recent management-plane audit entries (most recent first).",
          parameters: [
            { name: "from", in: "query", schema: { type: "string", format: "date-time" } },
            { name: "to", in: "query", schema: { type: "string", format: "date-time" } },
            { name: "actor", in: "query", schema: { type: "string" } },
            { name: "action", in: "query", schema: { type: "string" } },
            { name: "tenant", in: "query", schema: { type: "string" }, description: "Tenant scope. Non-admins are silently scoped to their own tenant; admins can pass any value (omit → all tenants)." },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
          ],
          responses: {
            "200": {
              description: "Audit feed plus the chain's tip hash.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      entries: { type: "array", items: { type: "object", additionalProperties: true } },
                      tipHash: { type: "string" },
                      persisted: { type: "boolean" },
                      scopedTo: { type: ["string", "null"], description: "Tenant name this view is scoped to; null = all tenants (admin)." },
                    },
                  },
                },
              },
            },
            "401": { description: "Unauthenticated (basic mode)." },
            "403": { description: "Missing audit:read permission." },
          },
        },
      },
      "/api/usage": {
        get: {
          tags: ["usage"],
          summary: "Per-identity windowed call count for /mcp callers.",
          parameters: [
            { name: "actor", in: "query", schema: { type: "string" }, description: "Narrow to a single identity." },
            { name: "tenant", in: "query", schema: { type: "string" }, description: "Tenant scope. Non-admins silently scoped to their own; admins can pick any (omit → all)." },
          ],
          responses: {
            "200": {
              description: "Usage snapshot. Anonymous /mcp traffic does not appear here.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      identities: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            actor: { type: "string" },
                            tenant: { type: "string", description: "Tenant the identity belongs to. 'default' when single-tenant." },
                            count: { type: "integer" },
                            limit: { type: "integer" },
                            windowMs: { type: "integer" },
                            tokens: {
                              type: "object",
                              description: "Per-identity 24h-rolling token usage. `limit: 0` means uncapped (OMCP_TOOL_DAILY_TOKENS unset).",
                              properties: {
                                used: { type: "integer" },
                                limit: { type: "integer" },
                                windowMs: { type: "integer" },
                              },
                            },
                          },
                        },
                      },
                      defaultLimit: { type: "integer" },
                      windowMs: { type: "integer" },
                      tokens: {
                        type: "object",
                        description: "Process-wide defaults for the token-budget tracker.",
                        properties: {
                          defaultLimit: { type: "integer" },
                          windowMs: { type: "integer" },
                        },
                      },
                    },
                  },
                },
              },
            },
            "403": { description: "Missing audit:read permission." },
          },
        },
      },
      "/api/policy": {
        get: {
          tags: ["auth"],
          summary: "Read-only view of the active RBAC policy (admin-only). Dry-run probe with ?resource=&action=&roles=.",
          parameters: [
            { name: "roles", in: "query", required: false, schema: { type: "string" }, description: "Comma-separated role names to probe. Defaults to none (treated as anonymous → always denied)." },
            { name: "resource", in: "query", required: false, schema: { type: "string" }, description: "Resource to probe. Pair with `action` to enter dry-run mode." },
            { name: "action", in: "query", required: false, schema: { type: "string" }, description: "Action to probe. Pair with `resource` to enter dry-run mode." },
          ],
          responses: {
            "200": {
              description: "Either the full policy map (no probe params) or a dry-run decision (with `resource` + `action`).",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      engine: { type: "string", description: "Identifier of the active engine: 'builtin', 'file:<path>', 'opa:<url>'." },
                      policy: { type: "object", additionalProperties: true },
                      roles: { type: "array", items: { type: "string" } },
                      note: { type: "string" },
                      dryRun: {
                        type: "object",
                        properties: {
                          roles: { type: "array", items: { type: "string" } },
                          resource: { type: "string" },
                          action: { type: "string" },
                          allowed: { type: "boolean" },
                          reason: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
            "403": { description: "Missing users:delete permission (admin-only)." },
          },
        },
      },
      "/api/catalog": {
        get: {
          tags: ["catalog"],
          summary: "Loaded service catalog (owner / tier / on-call / SLO).",
          parameters: [
            { name: "tenant", in: "query", schema: { type: "string" }, description: "Tenant scope. Non-admins silently scoped to their own; admins can pick any (omit → all)." },
          ],
          responses: {
            "200": {
              description: "Catalog map keyed by service name.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      services: { type: "object", additionalProperties: true },
                      count: { type: "integer" },
                      configured: { type: "boolean", description: "true when OMCP_SERVICE_CATALOG_FILE is set." },
                      scopedTo: { type: ["string", "null"], description: "Tenant name this view is scoped to; null = all tenants (admin)." },
                    },
                  },
                },
              },
            },
            "403": { description: "Missing catalog:read permission." },
          },
        },
      },
    },
  };
  return doc as unknown as OpenAPIV3_1.Document;
}
