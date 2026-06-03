import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildBypassBreadcrumb,
  buildBypassAuditParams,
} from "./redaction-bypass.js";
import type { RequestContext } from "../context.js";

function ctxFor(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    principalId: "agent",
    auth: "apikey",
    tenant: "acme",
    correlationId: "corr-123",
    ...overrides,
  };
}

test("buildBypassBreadcrumb — engaged path carries auth + tool + service + correlationId, NO credential fields", () => {
  const bc = buildBypassBreadcrumb(
    "redaction_bypass_engaged",
    ctxFor(),
    { service: "payment-service" },
    { nowIso: "2026-06-03T00:00:00.000Z" },
  );
  assert.equal(bc.event, "redaction_bypass_engaged");
  assert.equal(bc.ts, "2026-06-03T00:00:00.000Z");
  assert.equal(bc.auth, "apikey");
  assert.equal(bc.tool, "query_logs");
  assert.equal(bc.service, "payment-service");
  assert.equal(bc.correlationId, "corr-123");
  assert.equal(bc.reason, undefined, "engaged path must not carry a deny reason");
  // Guard: no credential-shaped fields. If a future edit adds the
  // principalId / token / cred-name to the breadcrumb, this fails.
  // We match KEY names (followed by ":") not value-string contents,
  // so the legitimate auth: "apikey" field survives.
  const serialised = JSON.stringify(bc);
  assert.doesNotMatch(serialised, /"(principalId|token|credential|apiKey|api_key|sub|name)"\s*:/i);
});

test("buildBypassBreadcrumb — denied path adds the deny reason; still no credential leak", () => {
  const bc = buildBypassBreadcrumb(
    "redaction_bypass_denied",
    ctxFor({ principalId: "ci-bot" }),
    { service: "svc" },
  );
  assert.equal(bc.event, "redaction_bypass_denied");
  assert.equal(bc.reason, "credential_not_in_OMCP_KEY_BYPASS_REDACTION");
  const serialised = JSON.stringify(bc);
  assert.doesNotMatch(serialised, /ci-bot/, "principalId must not appear in stderr breadcrumb");
});

test("buildBypassBreadcrumb — missing service becomes explicit null (not undefined)", () => {
  const bc = buildBypassBreadcrumb("redaction_bypass_engaged", ctxFor(), {});
  // Important: JSON.stringify omits undefined keys; null serialises
  // as `"service":null`, which downstream SIEM parsers can match on.
  assert.equal(bc.service, null);
  assert.match(JSON.stringify(bc), /"service":null/);
});

test("buildBypassAuditParams — engaged status 200, RBAC vocabulary, full identity", () => {
  const p = buildBypassAuditParams(true, ctxFor(), { service: "payment-service" });
  assert.equal(p.status, 200);
  assert.equal(p.resource, "redaction");
  assert.equal(p.action, "bypass");
  assert.equal(p.method, "MCP");
  assert.equal(p.path, "/mcp/query_logs");
  assert.equal(p.actor.sub, "agent");
  assert.equal(p.tenant, "acme");
  assert.equal(p.target, "payment-service");
});

test("buildBypassAuditParams — denied status 403 (not 200) so audit-log readers can distinguish attempt vs success", () => {
  const p = buildBypassAuditParams(false, ctxFor(), { service: "svc" });
  assert.equal(p.status, 403);
  // Critical: the deny path must still record actor.sub + tenant so
  // an investigator can see WHO tried, not just THAT someone tried.
  assert.equal(p.actor.sub, "agent");
  assert.equal(p.tenant, "acme");
});

test("buildBypassAuditParams — omits target when args.service is absent (not empty-string)", () => {
  const p = buildBypassAuditParams(true, ctxFor(), {});
  assert.equal(p.target, undefined);
  // Defence: an empty-string service should not become an audit target.
  const p2 = buildBypassAuditParams(true, ctxFor(), { service: "" });
  assert.equal(p2.target, undefined);
});

test("buildBypassAuditParams — tool name flows into the path so audit readers can filter per-tool", () => {
  const p = buildBypassAuditParams(true, ctxFor(), { service: "s" }, { tool: "query_metrics" });
  assert.equal(p.path, "/mcp/query_metrics");
});
