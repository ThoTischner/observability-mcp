// Proves the documented example configs are REAL working configs, not
// illustrative JSON: load them and run them through the actual enforcers
// with the principals from docs/enterprise-gate.md. If the docs and these
// files ever drift, this test fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { enforce, RbacDeniedError } from "../rbac/index.mjs";
import { enforceCatalog, CatalogDeniedError } from "../catalog/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const policy = JSON.parse(readFileSync(join(HERE, "rbac-policy.json"), "utf8"));
const catalog = JSON.parse(readFileSync(join(HERE, "catalog.json"), "utf8"));

const ctx = (id) => ({ principalId: id, auth: "apikey", correlationId: "c" });

test("example RBAC policy: sre bot may query, payments-oncall is scoped", () => {
  // platform-bot (role sre) may query any service.
  assert.equal(
    enforce(policy, ctx("key:platform-bot"), { tool: "query_metrics", service: "order-service" }).allow,
    true
  );
  // payments-oncall may read payment-service on prom-eu...
  assert.equal(
    enforce(policy, ctx("key:payments-oncall"), {
      tool: "get_service_health",
      source: "prom-eu",
      service: "payment-service",
    }).allow,
    true
  );
  // ...but not other services, sources, or mutating tools.
  assert.throws(
    () => enforce(policy, ctx("key:payments-oncall"), { tool: "query_metrics", service: "order-service" }),
    RbacDeniedError
  );
  assert.throws(
    () => enforce(policy, ctx("key:payments-oncall"), { tool: "query_metrics", source: "prom-us", service: "payment-service" }),
    RbacDeniedError
  );
  // Unknown principal is default-denied (defaultRoles is empty).
  assert.throws(() => enforce(policy, ctx("key:stranger"), { tool: "list_sources" }), RbacDeniedError);
});

test("example catalog: products scope each principal as documented", () => {
  assert.equal(
    enforceCatalog(catalog, ctx("key:platform-bot"), { source: "loki-eu", service: "anything" }).allow,
    true
  );
  assert.equal(
    enforceCatalog(catalog, ctx("key:payments-oncall"), { source: "prom-eu", service: "payment-service" }).allow,
    true
  );
  assert.throws(
    () => enforceCatalog(catalog, ctx("key:payments-oncall"), { source: "prom-eu", service: "order-service" }),
    CatalogDeniedError
  );
  assert.throws(
    () => enforceCatalog(catalog, ctx("key:stranger"), { source: "prom-eu" }),
    CatalogDeniedError
  );
});
