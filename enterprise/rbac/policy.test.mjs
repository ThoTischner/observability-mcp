import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, rolesFor } from "./policy.mjs";

const POLICY = {
  roles: {
    admin: { tools: ["*"], sources: ["*"], services: ["*"] },
    sre: { tools: ["query_metrics", "get_service_health"], sources: ["prom-eu"], services: ["*"] },
    auditor: { tools: ["*"], sources: ["*"], services: ["*"], readOnly: true },
    payments_only: { tools: ["query_metrics"], sources: ["*"], services: ["payment-service"] },
  },
  bindings: {
    alice: ["admin"],
    bob: ["sre"],
    carol: ["auditor"],
    dave: ["sre", "payments_only"],
  },
  defaultRoles: [],
};

test("default-deny: no policy / no tool / unbound principal", () => {
  assert.equal(evaluate(null, { principalId: "x", tool: "t" }).allow, false);
  assert.equal(evaluate(POLICY, { principalId: "alice" }).allow, false);
  const u = evaluate(POLICY, { principalId: "nobody", tool: "query_metrics" });
  assert.equal(u.allow, false);
  assert.match(u.reason, /no roles \(default-deny\)/);
});

test("admin wildcard grants anything", () => {
  const d = evaluate(POLICY, { principalId: "alice", tool: "detect_anomalies", source: "any", service: "any" });
  assert.equal(d.allow, true);
  assert.equal(d.matchedRole, "admin");
});

test("role tool allow-list is enforced", () => {
  assert.equal(evaluate(POLICY, { principalId: "bob", tool: "query_metrics", source: "prom-eu" }).allow, true);
  const denied = evaluate(POLICY, { principalId: "bob", tool: "detect_anomalies", source: "prom-eu" });
  assert.equal(denied.allow, false);
  assert.match(denied.reason, /tool 'detect_anomalies' not granted/);
});

test("role source allow-list is enforced", () => {
  const d = evaluate(POLICY, { principalId: "bob", tool: "query_metrics", source: "prom-us" });
  assert.equal(d.allow, false);
  assert.match(d.reason, /source 'prom-us' not granted/);
});

test("read-only role denies mutating actions but allows reads", () => {
  assert.equal(evaluate(POLICY, { principalId: "carol", tool: "query_metrics", mutating: false }).allow, true);
  const m = evaluate(POLICY, { principalId: "carol", tool: "update_config", mutating: true });
  assert.equal(m.allow, false);
  assert.match(m.reason, /read-only role denies a mutating action/);
});

test("multiple roles compose as a union", () => {
  // dave: sre (query_metrics on prom-eu) + payments_only (query_metrics, payment-service)
  assert.equal(
    evaluate(POLICY, { principalId: "dave", tool: "query_metrics", service: "payment-service" }).allow,
    true
  );
  // sre grants get_service_health only on prom-eu; payments_only doesn't grant it → with a
  // foreign source both roles fail.
  const d = evaluate(POLICY, { principalId: "dave", tool: "get_service_health", source: "prom-us" });
  assert.equal(d.allow, false);
});

test("service allow-list is enforced", () => {
  const d = evaluate(POLICY, { principalId: "dave", tool: "query_metrics", service: "order-service" });
  // sre allows services:* but source defaults absent; payments_only restricts service.
  assert.equal(d.allow, true); // sre grants (services "*", no source in request)
  const onlyPayments = evaluate(
    { roles: POLICY.roles, bindings: { x: ["payments_only"] } },
    { principalId: "x", tool: "query_metrics", service: "order-service" }
  );
  assert.equal(onlyPayments.allow, false);
  assert.match(onlyPayments.reason, /service 'order-service' not granted/);
});

test("defaultRoles applied to unbound principals", () => {
  const p = { roles: { ro: { tools: ["query_metrics"], sources: ["*"], services: ["*"] } }, bindings: {}, defaultRoles: ["ro"] };
  assert.equal(evaluate(p, { principalId: "anyone", tool: "query_metrics" }).allow, true);
  assert.equal(evaluate(p, { principalId: "anyone", tool: "delete_source" }).allow, false);
});

test("rolesFor: binding wins over default, missing → default", () => {
  assert.deepEqual(rolesFor(POLICY, "bob"), ["sre"]);
  assert.deepEqual(rolesFor({ bindings: {}, defaultRoles: ["ro"] }, "ghost"), ["ro"]);
  assert.deepEqual(rolesFor({ bindings: {} }, "ghost"), []);
});

test("undefined referenced role is skipped, not crashed", () => {
  const p = { roles: {}, bindings: { x: ["ghostrole"] } };
  const d = evaluate(p, { principalId: "x", tool: "query_metrics" });
  assert.equal(d.allow, false);
  assert.match(d.reason, /undefined role/);
});
