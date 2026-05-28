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
    "/api/audit",
    "/api/usage",
    "/api/policy",
    "/api/catalog",
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
