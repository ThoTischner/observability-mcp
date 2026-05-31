import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TENANT,
  MAX_TENANT_LENGTH,
  normaliseTenant,
  tenantFromClaim,
  parseKeyTenants,
} from "./context.js";

test("normaliseTenant — happy paths", () => {
  assert.equal(normaliseTenant("acme"), "acme");
  assert.equal(normaliseTenant("ACME"), "acme", "lowercases");
  assert.equal(normaliseTenant("  acme-corp  "), "acme-corp", "trims");
  assert.equal(normaliseTenant("team_a.us-east"), "team_a.us-east");
});

test("normaliseTenant — invalid / empty / null falls back to default", () => {
  assert.equal(normaliseTenant(undefined), DEFAULT_TENANT);
  assert.equal(normaliseTenant(null), DEFAULT_TENANT);
  assert.equal(normaliseTenant(""), DEFAULT_TENANT);
  assert.equal(normaliseTenant("   "), DEFAULT_TENANT);
  assert.equal(normaliseTenant(123), DEFAULT_TENANT);
  // Disallowed shapes
  assert.equal(normaliseTenant("acme/corp"), DEFAULT_TENANT, "slash rejected");
  assert.equal(normaliseTenant("acme corp"), DEFAULT_TENANT, "space rejected");
  assert.equal(normaliseTenant("..hidden"), DEFAULT_TENANT, "leading dot rejected");
  assert.equal(normaliseTenant("-leading"), DEFAULT_TENANT, "leading dash rejected");
  // Too long
  assert.equal(normaliseTenant("x".repeat(MAX_TENANT_LENGTH + 1)), DEFAULT_TENANT);
});

test("normaliseTenant — exactly MAX_TENANT_LENGTH passes", () => {
  const t = "a" + "x".repeat(MAX_TENANT_LENGTH - 1);
  assert.equal(t.length, MAX_TENANT_LENGTH);
  assert.equal(normaliseTenant(t), t);
});

test("tenantFromClaim — flat claim", () => {
  assert.equal(tenantFromClaim({ tenant: "acme" }, "tenant"), "acme");
  assert.equal(tenantFromClaim({ tenant: "ACME" }, "tenant"), "acme");
  assert.equal(tenantFromClaim({}, "tenant"), DEFAULT_TENANT);
});

test("tenantFromClaim — dotted claim path", () => {
  assert.equal(tenantFromClaim({ app: { tenant_id: "acme" } }, "app.tenant_id"), "acme");
  assert.equal(tenantFromClaim({ app: { tenant_id: "acme" } }, "app.missing"), DEFAULT_TENANT);
  assert.equal(tenantFromClaim({ app: { tenant_id: "acme" } }, "missing.path"), DEFAULT_TENANT);
});

test("tenantFromClaim — array claim takes first string entry", () => {
  assert.equal(tenantFromClaim({ tenants: ["acme", "other"] }, "tenants"), "acme");
  assert.equal(tenantFromClaim({ tenants: [123, "acme"] }, "tenants"), "acme");
  assert.equal(tenantFromClaim({ tenants: [123, 456] }, "tenants"), DEFAULT_TENANT);
});

test("tenantFromClaim — non-string scalar falls back", () => {
  assert.equal(tenantFromClaim({ tenant: 42 }, "tenant"), DEFAULT_TENANT);
  assert.equal(tenantFromClaim({ tenant: true }, "tenant"), DEFAULT_TENANT);
  assert.equal(tenantFromClaim({ tenant: null }, "tenant"), DEFAULT_TENANT);
});

test("tenantFromClaim — empty claimPath returns default", () => {
  assert.equal(tenantFromClaim({ tenant: "acme" }, ""), DEFAULT_TENANT);
});

test("parseKeyTenants — happy path", () => {
  const m = parseKeyTenants("ci=acme;agent=bigco; dev=team_a.us");
  assert.equal(m.size, 3);
  assert.equal(m.get("ci"), "acme");
  assert.equal(m.get("agent"), "bigco");
  assert.equal(m.get("dev"), "team_a.us");
});

test("parseKeyTenants — invalid tenant on the right-hand side normalises to default", () => {
  const m = parseKeyTenants("ci=acme/corp;agent=BIGCO");
  assert.equal(m.get("ci"), DEFAULT_TENANT, "slash → default");
  assert.equal(m.get("agent"), "bigco", "uppercase OK after normalise");
});

test("parseKeyTenants — malformed entries skipped, doesn't crash", () => {
  const m = parseKeyTenants("noequal;=novalueeither;valid=acme");
  assert.equal(m.size, 1);
  assert.equal(m.get("valid"), "acme");
});

test("parseKeyTenants — undefined / empty returns empty map", () => {
  assert.equal(parseKeyTenants(undefined).size, 0);
  assert.equal(parseKeyTenants("").size, 0);
});
