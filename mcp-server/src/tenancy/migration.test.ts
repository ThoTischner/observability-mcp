/**
 * Migration regression suite — pre-E7 single-tenant deployments must
 * continue to work without any config change. These tests pin the
 * "everything defaults to `default`" contract by simulating the
 * exact data shapes a pre-E7 server / file / token would carry.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultContext, principalContext } from "../context.js";
import { issueSession, verifySession } from "../auth/session.js";
import { loadCredentials } from "../auth/credentials.js";
import { CatalogStore } from "../catalog/loader.js";
import { AuditLog } from "../audit/log.js";
import { DEFAULT_TENANT } from "./context.js";

const SECRET = "x".repeat(32);

test("migration — anonymous context lands in DEFAULT_TENANT", () => {
  const ctx = defaultContext();
  assert.equal(ctx.tenant, DEFAULT_TENANT);
});

test("migration — principalContext without tenant opt → DEFAULT_TENANT", () => {
  const ctx = principalContext("agent", ["prom-prod"]);
  assert.equal(ctx.tenant, DEFAULT_TENANT);
});

test("migration — pre-E7 session cookie (no tenant field) verifies + reads back fine", () => {
  // Session minted as it would have been pre-E7: no tenant.
  const { cookie } = issueSession({ sub: "alice", name: "Alice", roles: ["operator"] }, { secret: SECRET });
  const verified = verifySession(cookie, { secret: SECRET });
  assert.ok(verified, "verifySession should accept a pre-E7 cookie");
  assert.equal(verified.tenant, undefined, "tenant stays undefined; consumers default to 'default'");
});

test("migration — pre-E7 OMCP_API_KEYS (no OMCP_KEY_TENANTS) leaves credentials in DEFAULT_TENANT", () => {
  const creds = loadCredentials({ OMCP_API_KEYS: "agent:tok_abc,ci:tok_def" });
  assert.equal(creds.length, 2);
  for (const c of creds) {
    assert.equal(c.tenant, undefined, "no env → no tenant assignment → consumers default to 'default'");
  }
});

test("migration — pre-E7 catalog (entries without tenant field) still enriches DEFAULT_TENANT callers", () => {
  const store = new CatalogStore({
    services: {
      "payments": { owner: "team-payments" }, // pre-E7 shape
      "shipping": { owner: "team-shipping" },
    },
  });
  // A pre-E7 caller (no session, ctx.tenant = "default") sees both
  // entries through the tenant-aware get().
  assert.equal(store.get("payments", DEFAULT_TENANT)?.owner, "team-payments");
  assert.equal(store.get("shipping", DEFAULT_TENANT)?.owner, "team-shipping");
  // Same caller via the unfiltered get path also sees them (admins).
  assert.equal(store.get("payments")?.owner, "team-payments");
});

test("migration — pre-E7 audit entries (no tenant field) surface under ?tenant=default", async () => {
  const log = new AuditLog();
  // Pre-E7 record: no tenant.
  await log.record({ actor: { sub: "alice" }, resource: "sources", action: "write", method: "POST", path: "/api/sources", status: 200 });
  const entries = log.list({ tenant: "default" });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].actor.sub, "alice");
});

test("migration — opt-in is per-entry: an admin defining `tenant: acme` doesn't break the rest", () => {
  const store = new CatalogStore({
    services: {
      "acme-app": { owner: "acme-team", tenant: "acme" },        // opted in
      "shared-cdn": { owner: "infra" },                            // pre-E7 shape
    },
  });
  // The acme-tenant caller sees only their entry.
  assert.equal(store.count("acme"), 1);
  assert.equal(store.get("shared-cdn", "acme"), undefined);
  // The default-tenant caller (anonymous / single-tenant) sees only
  // the pre-E7 entry — the acme entry is correctly hidden.
  assert.equal(store.count("default"), 1);
  assert.equal(store.get("acme-app", "default"), undefined);
  assert.equal(store.get("shared-cdn", "default")?.owner, "infra");
});
