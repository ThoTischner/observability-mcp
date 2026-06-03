import { test } from "node:test";
import assert from "node:assert/strict";

import { buildOpenApiSpec } from "./openapi.js";

test("openapi — every user-visible /api path is documented", () => {
  // If a future PR adds an endpoint here, also document it in
  // openapi.ts. The list intentionally excludes admin-only routes the
  // spec deliberately keeps internal — add to that allow-list rather
  // than mass-adding routes to the spec.
  const documentedRoutes = [
    "/api/health",
    "/api/services",
    "/api/sources",
    "/api/sources/{name}",
    "/api/sources/{name}/metrics",
    "/api/source-types",
    "/api/settings",
    "/api/health-thresholds",
    "/api/me",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/oidc/login",
    "/api/auth/oidc/callback",
    "/api/auth/oidc/logout",
    "/api/audit",
    "/api/usage",
    "/api/policy",
    "/api/catalog",
    "/api/products",
    "/api/products/{id}",
    "/api/info",
    "/api/openapi.json",
  ];
  const spec = buildOpenApiSpec("test-1.0.0");
  const paths = Object.keys(spec.paths || {});
  for (const route of documentedRoutes) {
    assert.ok(paths.includes(route), `expected ${route} to be in the OpenAPI spec, paths=${paths.join(", ")}`);
  }
});

test("openapi — /api/info governance block schema documents every field the handler returns", () => {
  const spec = buildOpenApiSpec("test-1.0.0");
  const info = spec.paths?.["/api/info"]?.get;
  assert.ok(info, "/api/info should be documented");
  // Walk down to the governance properties; the schema is inlined so
  // we don't have to chase $refs.
  const schema = (info as any).responses["200"].content["application/json"].schema;
  const gov = schema.properties?.governance?.properties;
  assert.ok(gov, "governance block should be a documented object schema");
  for (const field of [
    "authMode",
    "authSecretEphemeral",
    "oidcIssuer",
    "auditPersisted",
    "catalogConfigured",
    "redaction",
    "trustProxy",
    "toolRatePerMin",
  ]) {
    assert.ok(field in gov, `governance.${field} should be in the schema (got: ${Object.keys(gov).join(", ")})`);
  }
});

test("openapi — info.version is the version string the caller passed in", () => {
  const spec = buildOpenApiSpec("9.9.9-test");
  assert.equal(spec.info?.version, "9.9.9-test");
});

test("openapi — SOURCE_SCHEMA exposes the tenant field (tenant-aware sources contract)", () => {
  // Source entries gained a `tenant` field when per-tenant connector
  // scoping shipped. The spec is the contract operators write
  // generated clients against — drift = broken downstream clients.
  const spec = buildOpenApiSpec("test-1.0.0");
  // SOURCE_SCHEMA is inlined into both `items` of GET /api/sources and
  // the requestBody of POST/PUT — pick the GET response, the canonical
  // read path.
  const sources = spec.paths?.["/api/sources"]?.get as unknown as { responses: { "200": { content: { "application/json": { schema: { items: { properties: Record<string, unknown> } } } } } } };
  const items = sources.responses["200"].content["application/json"].schema.items;
  assert.ok(items.properties.tenant, "SOURCE_SCHEMA must document `tenant` (added when per-tenant scoping shipped)");
});

test("openapi — /api/sources GET documents the admin `?tenant=` drill-down query param", () => {
  const spec = buildOpenApiSpec("test-1.0.0");
  const get = spec.paths?.["/api/sources"]?.get as unknown as { parameters?: Array<{ name: string; in: string }> };
  const params = get.parameters || [];
  const tenantParam = params.find((p) => p.name === "tenant" && p.in === "query");
  assert.ok(tenantParam, "GET /api/sources must document the admin `?tenant=` drill-down param");
});

test("openapi — /api/policy GET documents the `?tenant=` probe param + `tenantAware` snapshot field", () => {
  const spec = buildOpenApiSpec("test-1.0.0");
  const get = spec.paths?.["/api/policy"]?.get as unknown as {
    parameters: Array<{ name: string; in: string }>;
    responses: { "200": { content: { "application/json": { schema: { properties: Record<string, unknown> } } } } };
  };
  const params = get.parameters || [];
  assert.ok(params.some((p) => p.name === "tenant" && p.in === "query"), "GET /api/policy must document the `?tenant=` probe param");
  const schema = get.responses["200"].content["application/json"].schema;
  assert.ok(schema.properties.tenantAware, "snapshot must document the `tenantAware` field");
  const dryRun = schema.properties.dryRun as { properties?: Record<string, unknown> };
  assert.ok(dryRun?.properties?.tenant, "dryRun must echo the `tenant` field so operators see which tenant the verdict ran under");
});
