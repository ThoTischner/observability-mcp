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
    tenant: {
      type: "string",
      description: "Tenant this source belongs to. Omitted = global (visible to every tenant). Tagged sources are visible only inside their named tenant; cross-tenant probes return 404 with no existence leak.",
    },
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
          summary: "List configured sources with live health (tenant-scoped).",
          description: "Non-admin callers see only their own tenant's sources + globals (untagged). Admins (users:delete) see every source; pass ?tenant=X for an admin drill-down to that tenant + globals. Anonymous mode bypasses scoping (single-tenant default).",
          parameters: [
            { name: "tenant", in: "query", schema: { type: "string" }, description: "Admin-only tenant drill-down (silently ignored for non-admins, who are scoped to their own tenant)." },
          ],
          responses: {
            "200": {
              description: "Sources with status, latency, signal type. The `tenant` field is present when the source is tagged.",
              content: { "application/json": { schema: { type: "array", items: SOURCE_SCHEMA } } },
            },
          },
        },
        post: {
          tags: ["sources"],
          summary: "Add a new source (tenant-aware).",
          description: "Body may include `tenant` to tag the source. Non-admins may only create within their own tenant; setting body.tenant to another value returns 403. Admins may leave tenant unset (global) or set any value.",
          requestBody: { required: true, content: { "application/json": { schema: SOURCE_SCHEMA } } },
          responses: {
            "201": { description: "Source created." },
            "400": { description: "Validation error." },
            "403": { description: "Non-admin attempting to create in another tenant." },
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
          summary: "Replace an existing source (tenant-aware).",
          description: "Non-admin probes of a cross-tenant source return 404 (no existence leak — same posture as /api/products). Non-admins attempting to reassign body.tenant return 403. Admins may move sources between tenants.",
          requestBody: { required: true, content: { "application/json": { schema: SOURCE_SCHEMA } } },
          responses: {
            "200": { description: "Updated." },
            "403": { description: "Non-admin attempting tenant reassignment." },
            "404": { description: "Not found (or hidden by tenant scope)." },
          },
        },
        delete: {
          tags: ["sources"],
          summary: "Remove a source.",
          description: "Cross-tenant deletes return 404 (no existence leak).",
          responses: {
            "204": { description: "Removed." },
            "404": { description: "Not found (or hidden by tenant scope)." },
          },
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
      "/api/tools/registry": {
        get: {
          tags: ["products"],
          summary: "MCP tool catalogue — name + category + one-line summary, used by the Products picker.",
          description: "Static metadata derived from REGISTERED_TOOLS. The Products modal pulls this to populate a multi-select picker grouped by category (discovery / query / diagnose / topology); the server-side typo guard (PR #343) stays as defence-in-depth.",
          responses: {
            "200": {
              description: "Tool registry.",
              content: { "application/json": { schema: {
                type: "object",
                properties: {
                  tools: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["name", "category", "summary"],
                      properties: {
                        name: { type: "string" },
                        category: { type: "string", enum: ["discovery", "query", "diagnose", "topology"] },
                        summary: { type: "string" },
                      },
                    },
                  },
                },
              } } },
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
          summary: "Read-only view of the active RBAC policy (admin-only). Dry-run probe with ?resource=&action=&roles=[&tenant=].",
          parameters: [
            { name: "roles", in: "query", required: false, schema: { type: "string" }, description: "Comma-separated role names to probe. Defaults to none (treated as anonymous → always denied)." },
            { name: "resource", in: "query", required: false, schema: { type: "string" }, description: "Resource to probe. Pair with `action` to enter dry-run mode." },
            { name: "action", in: "query", required: false, schema: { type: "string" }, description: "Action to probe. Pair with `resource` to enter dry-run mode." },
            { name: "tenant", in: "query", required: false, schema: { type: "string" }, description: "Tenant to probe under (dry-run only). Defaults to the caller's session tenant; admins may override to probe verdicts for any tenant — exactly how to debug tenant-conditional Rego rules under the OPA engine." },
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
                      tenantAware: { type: "boolean", description: "True when the active engine honours session.tenant on .evaluate() — i.e. OPA. Built-in / file-loaded engines ignore tenant ctx (false)." },
                      policy: { type: "object", additionalProperties: true },
                      roles: { type: "array", items: { type: "string" } },
                      note: { type: "string" },
                      dryRun: {
                        type: "object",
                        properties: {
                          roles: { type: "array", items: { type: "string" } },
                          resource: { type: "string" },
                          action: { type: "string" },
                          tenant: { type: "string", description: "Tenant the probe ran under (echoed from ?tenant= or the caller's session)." },
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
      "/api/users/{username}/roles": {
        put: {
          tags: ["auth"],
          summary: "Update a local user's role assignments (admin-only, file-backed).",
          description: "Writes through OMCP_USERS_FILE. Roles are validated against the active policy engine's role catalogue; unknown role names return 422 with OMCP_USER_UNKNOWN_ROLE. The in-memory user store is refreshed atomically after the file write so the next login picks up the new roles without a server restart.",
          parameters: [
            { name: "username", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              required: ["roles"],
              properties: { roles: { type: "array", items: { type: "string" } } },
            } } },
          },
          responses: {
            "200": { description: "Roles updated." },
            "400": { description: "Body must be { roles: string[] }." },
            "403": { description: "Missing users:delete permission (admin-only)." },
            "404": { description: "User not found OR users file unreadable." },
            "409": { description: "OMCP_USERS_FILE is not configured — basic-mode user roles can't be edited via the API." },
            "422": { description: "tools[] references unknown role names. Body includes `unknown` + `available`; error code OMCP_USER_UNKNOWN_ROLE." },
          },
        },
      },
      "/api/subjects": {
        get: {
          tags: ["auth"],
          summary: "Aggregated subjects view — local users + API-key names + OIDC group mappings (admin-only).",
          description: "Read-only catalogue of the principals an OMCP deployment knows about. Three independent sources: OMCP_USERS_FILE (users), OMCP_API_KEYS (apiKeys), OMCP_OIDC_ROLE_MAP (oidcGroups). Tokens + password hashes are never returned — only metadata.",
          responses: {
            "200": {
              description: "Subjects payload.",
              content: { "application/json": { schema: {
                type: "object",
                properties: {
                  users: { type: "array", items: { type: "object", properties: {
                    username: { type: "string" }, name: { type: "string" },
                    roles: { type: "array", items: { type: "string" } },
                    tenant: { type: "string" },
                  } } },
                  apiKeys: { type: "array", items: { type: "object", properties: {
                    name: { type: "string" }, tenant: { type: "string" },
                    productId: { type: "string" },
                    bypassRedaction: { type: "boolean" },
                    allowedSources: { type: "array", items: { type: "string" } },
                  } } },
                  oidcGroups: { type: "array", items: { type: "object", properties: {
                    claim: { type: "string" }, role: { type: "string" },
                  } } },
                  sources: { type: "object", properties: {
                    users: { type: ["string", "null"] },
                    apiKeys: { type: ["string", "null"] },
                    oidcGroups: { type: ["string", "null"] },
                  } },
                },
              } } },
            },
            "403": { description: "Missing users:delete permission (admin-only)." },
          },
        },
      },
      "/api/products": {
        get: {
          tags: ["products"],
          summary: "Loaded MCP Products catalogue (curated tool bundles for agents).",
          parameters: [
            { name: "tenant", in: "query", schema: { type: "string" }, description: "Tenant scope. Non-admins silently scoped to their own; admins can pick any (omit → all)." },
          ],
          responses: {
            "200": {
              description: "Products list scoped to caller's tenant; admins see staging entries too.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      products: { type: "array", items: { type: "object", additionalProperties: true } },
                      configured: { type: "boolean" },
                      scopedTo: { type: ["string", "null"] },
                      includesStaging: { type: "boolean" },
                    },
                  },
                },
              },
            },
            "403": { description: "Missing products:read permission." },
          },
        },
        post: {
          tags: ["products"],
          summary: "Create a new product (strict create — 409 on conflict; PUT for upsert).",
          description: "Strict create-only variant of PUT. Same tenancy + typo-guard posture. Returns 409 when a product with body.id already exists. Body must include id + name; tools[] entries must reference registered MCP tool names (typo → 422).",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
          },
          responses: {
            "201": { description: "Created.", content: { "application/json": { schema: { type: "object", properties: {
              product: { type: "object", additionalProperties: true },
              persisted: { type: "boolean" },
            } } } } },
            "400": { description: "Body invalid (missing id / shape rejected by validateProduct)." },
            "403": { description: "Missing products:write permission, or non-admin attempting to create in another tenant." },
            "409": { description: "Product with that id already exists — use PUT to update." },
            "422": { description: "tools[] references unknown tool names. Body includes `unknown` + `available`; error code OMCP_PRODUCT_UNKNOWN_TOOL." },
          },
        },
      },
      "/api/products/{id}": {
        get: {
          tags: ["products"],
          summary: "Single product by id (404 on cross-tenant or staging probe by non-admin).",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "The product entry.", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            "404": { description: "Not found (or hidden by tenant / staging scope)." },
            "403": { description: "Missing products:read permission." },
          },
        },
        put: {
          tags: ["products"],
          summary: "Upsert a product (admin + operator). Body must match the OMCP_PRODUCTS_FILE entry shape.",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
          },
          responses: {
            "200": {
              description: "Upsert succeeded; returns the validated product + a persisted flag.",
              content: { "application/json": { schema: { type: "object", properties: {
                product: { type: "object", additionalProperties: true },
                persisted: { type: "boolean", description: "True when OMCP_PRODUCTS_FILE was set and the file was rewritten." },
              } } } },
            },
            "400": { description: "Body shape invalid (validateProduct rejected — typo, unknown key, wrong type, ...)." },
            "403": { description: "Missing products:write permission, or non-admin attempting to write into another tenant." },
            "404": { description: "Existing product belongs to a different tenant (non-admin)." },
            "422": { description: "tools[] references unknown tool names. Body includes `unknown` + `available`; error code OMCP_PRODUCT_UNKNOWN_TOOL." },
          },
        },
        delete: {
          tags: ["products"],
          summary: "Delete a product by id (admin only).",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "204": { description: "Deleted." },
            "403": { description: "Missing products:delete permission." },
            "404": { description: "Not found (or hidden by tenant scope)." },
          },
        },
      },
      "/api/products/{id}/preview": {
        get: {
          tags: ["products"],
          summary: "Agent preview — the filtered tools/list a credential bound to this product would receive.",
          description: "Same tenancy + staging filter as GET /api/products/{id}. Returns the product's branding/identity metadata + the registered MCP tools after applying its tools allow-list. The UI uses this for the per-card 'Preview as agent' affordance.",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Preview payload.",
              content: { "application/json": { schema: {
                type: "object",
                required: ["product", "unrestricted", "tools"],
                properties: {
                  product: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                      version: { type: "string" },
                      branding: { type: "object", additionalProperties: true },
                      tenant: { type: "string" },
                      status: { type: "string" },
                    },
                  },
                  unrestricted: { type: "boolean", description: "True when the product has no tools allow-list — the bound agent sees every registered tool." },
                  tools: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        category: { type: "string", enum: ["discovery", "query", "diagnose", "topology"] },
                        summary: { type: "string" },
                      },
                    },
                  },
                },
              } } },
            },
            "404": { description: "Not found (or hidden by tenant / staging scope)." },
            "403": { description: "Missing products:read permission." },
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
