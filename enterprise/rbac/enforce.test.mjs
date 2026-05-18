import { test } from "node:test";
import assert from "node:assert/strict";
import { enforce, check, RbacDeniedError } from "./enforce.mjs";

const POLICY = {
  roles: {
    sre: { tools: ["query_metrics", "get_service_health"], sources: ["*"], services: ["*"] },
  },
  bindings: { "key:bob": ["sre"] },
};

const ctx = (over = {}) => ({ principalId: "key:bob", auth: "apikey", correlationId: "c1", ...over });

test("enforce returns the allow decision on grant", () => {
  const d = enforce(POLICY, ctx(), { tool: "query_metrics", source: "prom-eu" });
  assert.equal(d.allow, true);
  assert.equal(d.matchedRole, "sre");
});

test("enforce throws RbacDeniedError on deny, tool never runs", () => {
  let ran = false;
  try {
    enforce(POLICY, ctx(), { tool: "delete_source" });
    ran = true;
  } catch (e) {
    assert.ok(e instanceof RbacDeniedError);
    assert.equal(e.code, "RBAC_DENIED");
    assert.match(e.message, /not granted/);
    assert.equal(e.request.tool, "delete_source");
  }
  assert.equal(ran, false);
});

test("context allowedSources is a hard upper bound RBAC cannot exceed", () => {
  // Policy would allow any source, but the context pins the allow-list.
  const e = check(POLICY, ctx({ allowedSources: ["prom-eu"] }), {
    tool: "query_metrics",
    source: "prom-us",
  });
  assert.equal(e.allow, false);
  assert.match(e.reason, /outside the context allow-list/);
  // Within the pinned list it passes through to the policy and is allowed.
  assert.equal(
    check(POLICY, ctx({ allowedSources: ["prom-eu"] }), { tool: "query_metrics", source: "prom-eu" }).allow,
    true
  );
});

test("anonymous/unbound principal is denied (default-deny seam)", () => {
  const d = check(POLICY, { principalId: "anonymous", auth: "anonymous" }, { tool: "query_metrics" });
  assert.equal(d.allow, false);
  assert.match(d.reason, /no roles \(default-deny\)/);
});

test("check() never throws RbacDeniedError, returns the decision", () => {
  const d = check(POLICY, ctx(), { tool: "nope" });
  assert.equal(d.allow, false);
  assert.equal(typeof d.reason, "string");
});

test("missing ctx is treated as anonymous → denied", () => {
  const d = check(POLICY, undefined, { tool: "query_metrics" });
  assert.equal(d.allow, false);
});
