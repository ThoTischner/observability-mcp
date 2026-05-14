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
  return {
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
    },
  };
}
