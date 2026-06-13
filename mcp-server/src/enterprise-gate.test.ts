import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultContext } from "./context.js";
import {
  enforceEntitledAccess,
  enterpriseGateStatus,
  enterpriseGateInfo,
  enterprisePolicyView,
  enterpriseCatalogView,
  enterpriseAuditTail,
  validatePolicyShape,
  validateCatalogShape,
  authorizeAdmin,
  featureEntitled,
  inspectEnforceEntitled,
  entitledFeatures,
  ENTITLEABLE_FEATURES,
  _resetEnterpriseGate,
} from "./enterprise-gate.js";

// These tests run in the mcp-server sandbox where enterprise/ is ABSENT
// (it is excluded from the npm package and the Docker build context) —
// exactly the published-artifact state. They pin the security contract:
//
//   - no opt-in            → OFF, perfect no-op (zero behaviour change)
//   - control configured   → FAIL-CLOSED when the gate can't activate
//                            (a broken/absent entitlement must DENY,
//                             never silently open)

function clearEnv() {
  for (const k of [
    "OMCP_ENTITLEMENT_TOKEN",
    "OMCP_ENTITLEMENT_PUBKEY",
    "OMCP_RBAC_POLICY",
    "OMCP_CATALOG",
    "OMCP_AUDIT_FILE",
  ]) {
    delete process.env[k];
  }
  _resetEnterpriseGate();
}

describe("enterprise-gate — OFF (no opt-in, published-artifact state)", () => {
  afterEach(clearEnv);

  it("no entitlement, no controls → awaited no-op, gate mode 'off'", async () => {
    clearEnv();
    await assert.doesNotReject(
      enforceEntitledAccess(defaultContext(), { tool: "query_metrics", service: "payment" })
    );
    const st = await enterpriseGateStatus();
    assert.equal(st.active, false);
    assert.equal(st.mode, "off");
  });

  it("token set but NO control configured → still OFF (no opt-in), no throw", async () => {
    clearEnv();
    process.env.OMCP_ENTITLEMENT_TOKEN = "deadbeef.cafebabe";
    process.env.OMCP_ENTITLEMENT_PUBKEY = "-----BEGIN PUBLIC KEY-----\\nX\\n-----END PUBLIC KEY-----";
    _resetEnterpriseGate();
    await assert.doesNotReject(enforceEntitledAccess(defaultContext(), { tool: "list_sources" }));
    assert.equal((await enterpriseGateStatus()).mode, "off");
  });

  it("every tool name passes through cleanly when OFF", async () => {
    clearEnv();
    for (const tool of [
      "list_sources",
      "list_services",
      "query_metrics",
      "query_logs",
      "get_service_health",
      "detect_anomalies",
    ]) {
      await assert.doesNotReject(enforceEntitledAccess(defaultContext(), { tool }));
    }
  });

  it("featureEntitled is false for every feature when OFF (OSS default)", async () => {
    clearEnv();
    // Default-OFF means no entitled feature is active — SSO/SCIM/tenancy/
    // inspect-enforce all stay locked, so the OSS surface is unchanged and
    // a feature only ever gates when the operator has actively licensed it.
    for (const feature of ["sso", "scim", "tenancy", "inspect-enforce", "anything"]) {
      assert.equal(await featureEntitled(feature), false, `feature ${feature} must be locked when OFF`);
    }
    assert.equal(await inspectEnforceEntitled(), false, "inspectEnforceEntitled mirrors featureEntitled");
  });

  it("entitledFeatures returns the full vocabulary, all false when OFF", async () => {
    clearEnv();
    const map = await entitledFeatures();
    // Every known feature is present as a key (so the UI can render a badge
    // for each) and false on the OSS default.
    for (const f of ENTITLEABLE_FEATURES) {
      assert.equal(map[f], false, `feature ${f} must be false when OFF`);
    }
    assert.deepEqual(Object.keys(map).sort(), [...ENTITLEABLE_FEATURES].sort());
  });

  it("gate state is memoised across calls", async () => {
    clearEnv();
    assert.deepEqual(await enterpriseGateStatus(), await enterpriseGateStatus());
  });
});

describe("enterprise-gate — FAIL-CLOSED (opted in, cannot activate)", () => {
  afterEach(clearEnv);

  it("RBAC policy configured but enterprise/ absent → DENY every tool call", async () => {
    clearEnv();
    const dir = mkdtempSync(join(tmpdir(), "gate-fc-"));
    const policy = join(dir, "rbac.json");
    writeFileSync(policy, JSON.stringify({ roles: {}, bindings: {} }));
    process.env.OMCP_RBAC_POLICY = policy; // operator opted into a control
    _resetEnterpriseGate();

    const st = await enterpriseGateStatus();
    assert.equal(st.active, false);
    assert.equal(st.mode, "fail-closed");

    await assert.rejects(
      () => enforceEntitledAccess(defaultContext(), { tool: "query_metrics" }),
      /access denied: enterprise control configured but inactive/
    );
  });

  it("control configured + no token → fail-closed (not a silent open)", async () => {
    clearEnv();
    process.env.OMCP_CATALOG = "/nonexistent/catalog.json";
    _resetEnterpriseGate();
    assert.equal((await enterpriseGateStatus()).mode, "fail-closed");
    await assert.rejects(
      () => enforceEntitledAccess(defaultContext(), { tool: "list_services" }),
      /access denied/
    );
  });
});

describe("enterprise-gate — read-only console introspection", () => {
  afterEach(clearEnv);

  it("gateInfo: off → entitlement null, no token ever exposed", async () => {
    clearEnv();
    process.env.OMCP_ENTITLEMENT_TOKEN = "SECRET.SHOULD-NEVER-LEAK";
    process.env.OMCP_ENTITLEMENT_PUBKEY = "x";
    _resetEnterpriseGate();
    const info = await enterpriseGateInfo();
    assert.equal(info.active, false);
    assert.equal(info.entitlement, null);
    assert.equal("rbacConfigured" in info, true);
    const dump = JSON.stringify(info);
    assert.equal(dump.includes("SECRET"), false, "token must never appear in gate info");
  });

  it("gateInfo: configured-flags reflect env", async () => {
    clearEnv();
    process.env.OMCP_RBAC_POLICY = "/tmp/x.json";
    process.env.OMCP_AUDIT_FILE = "/tmp/a.jsonl";
    _resetEnterpriseGate();
    const info = await enterpriseGateInfo();
    assert.equal(info.rbacConfigured, true);
    assert.equal(info.catalogConfigured, false);
    assert.equal(info.auditConfigured, true);
  });

  it("policy/catalog view: not configured vs file error", () => {
    clearEnv();
    assert.deepEqual(enterprisePolicyView(), { configured: false });
    assert.deepEqual(enterpriseCatalogView(), { configured: false });
    const dir = mkdtempSync(join(tmpdir(), "gate-ro-"));
    const f = join(dir, "p.json");
    writeFileSync(f, '{"roles":{"a":{"tools":["*"]}},"bindings":{}}');
    process.env.OMCP_RBAC_POLICY = f;
    const v = enterprisePolicyView();
    assert.equal(v.configured, true);
    assert.deepEqual(Object.keys((v as any).data.roles), ["a"]);
    process.env.OMCP_RBAC_POLICY = "/no/such/file.json";
    const e = enterprisePolicyView();
    assert.equal(e.configured, true);
    assert.ok((e as any).error);
  });

  it("audit tail: not configured when no audit file", async () => {
    clearEnv();
    assert.deepEqual(await enterpriseAuditTail(10), { configured: false });
  });
});

describe("enterprise-gate — P2 admin RBAC write", () => {
  afterEach(clearEnv);

  it("validatePolicyShape accepts a well-formed policy", () => {
    assert.equal(
      validatePolicyShape({ roles: { a: { tools: ["*"] } }, bindings: { p: ["a"] }, defaultRoles: [] }),
      null
    );
  });

  it("validatePolicyShape rejects malformed shapes", () => {
    assert.match(validatePolicyShape(null) || "", /must be a JSON object/);
    assert.match(validatePolicyShape([]) || "", /must be a JSON object/);
    assert.match(validatePolicyShape({ bindings: {} }) || "", /roles must be an object/);
    assert.match(validatePolicyShape({ roles: {} }) || "", /bindings must be an object/);
    assert.match(
      validatePolicyShape({ roles: {}, bindings: {}, defaultRoles: "x" }) || "",
      /defaultRoles must be an array/
    );
    assert.match(
      validatePolicyShape({ roles: { r: { tools: "x" } }, bindings: {} }) || "",
      /role 'r.tools' must be an array/
    );
    assert.match(
      validatePolicyShape({ roles: {}, bindings: { p: "x" } }) || "",
      /binding 'p' must be an array/
    );
  });

  it("authorizeAdmin denies when the gate is not active", async () => {
    clearEnv(); // no entitlement → mode off
    const r = await authorizeAdmin("someone");
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.match(r.error ?? "", /gate not active/);
  });

  it("authorizeAdmin requires a principal once a control is configured", async () => {
    clearEnv();
    process.env.OMCP_RBAC_POLICY = "/tmp/none.json"; // fail-closed (no token)
    _resetEnterpriseGate();
    const r = await authorizeAdmin(null);
    assert.equal(r.ok, false);
    // gate is fail-closed here → still 409 (not active); never silently allows
    assert.equal(r.ok, false);
  });
});

describe("enterprise-gate — P3 catalog write validation", () => {
  it("validateCatalogShape accepts a well-formed catalog", () => {
    assert.equal(
      validateCatalogShape({
        products: { p: { sources: ["*"], services: ["a"] } },
        grants: { who: ["p"] },
        defaultProducts: [],
      }),
      null
    );
  });

  it("validateCatalogShape rejects malformed shapes", () => {
    assert.match(validateCatalogShape(null) || "", /must be a JSON object/);
    assert.match(validateCatalogShape({ grants: {} }) || "", /products must be an object/);
    assert.match(validateCatalogShape({ products: {} }) || "", /grants must be an object/);
    assert.match(
      validateCatalogShape({ products: { p: {} }, grants: {} }) || "",
      /product 'p.sources' must be an array/
    );
    assert.match(
      validateCatalogShape({ products: { p: { sources: [], services: "x" } }, grants: {} }) || "",
      /product 'p.services' must be an array/
    );
    assert.match(
      validateCatalogShape({ products: {}, grants: { g: "x" } }) || "",
      /grant 'g' must be an array/
    );
    assert.match(
      validateCatalogShape({ products: {}, grants: {}, defaultProducts: 1 }) || "",
      /defaultProducts must be an array/
    );
  });
});
