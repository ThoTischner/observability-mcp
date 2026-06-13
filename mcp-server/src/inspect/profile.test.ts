import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveProfile, evaluateCall, ruleId, type ProfileRule } from "./profile.js";
import type { Observation } from "./store.js";

let seq = 0;
function obs(over: Partial<Observation> = {}): Observation {
  return {
    ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    seq: ++seq,
    principal: "key:bot",
    auth: "apikey",
    tenant: "default",
    tool: "query_logs",
    argShape: {},
    outcome: "ok",
    decision: "allow",
    redactions: 0,
    ...over,
  };
}

describe("deriveProfile", () => {
  it("creates one suggested rule per (subject,tool) with unioned constraints", () => {
    const rules = deriveProfile([
      obs({ principal: "alice", tool: "query_logs", service: "pay", argShape: { window: "<=1h" } }),
      obs({ principal: "alice", tool: "query_logs", service: "order", argShape: { window: "<=5m" } }),
      obs({ principal: "bob", tool: "query_metrics", source: "prom" }),
    ]);
    assert.equal(rules.length, 2);
    const a = rules.find((r) => r.id === ruleId("alice", "query_logs"))!;
    assert.equal(a.status, "suggested");
    assert.deepEqual(a.constraints.service, ["order", "pay"]); // sorted union
    assert.deepEqual(a.constraints.argShape!.window, ["<=1h", "<=5m"]);
    assert.equal(a.provenance.learnedFrom, 2);
    const b = rules.find((r) => r.id === ruleId("bob", "query_metrics"))!;
    assert.deepEqual(b.constraints.source, ["prom"]);
  });

  it("is idempotent and never overwrites a human decision", () => {
    let rules = deriveProfile([obs({ principal: "a", tool: "t", service: "s1" })]);
    rules = rules.map((r) => ({ ...r, status: "accepted" as const }));
    // New traffic with a NEW service value arrives + re-derive.
    const after = deriveProfile([obs({ principal: "a", tool: "t", service: "s2" })], rules);
    const r = after.find((x) => x.id === ruleId("a", "t"))!;
    assert.equal(r.status, "accepted"); // untouched
    assert.deepEqual(r.constraints.service, ["s1"]); // NOT widened to include s2
  });

  it("does not resurrect a rejected rule", () => {
    const rejected: ProfileRule[] = [{
      id: ruleId("a", "t"), subject: "a", tool: "t", constraints: {}, status: "rejected",
      provenance: { learnedFrom: 1, firstSeen: "x", lastSeen: "x" },
    }];
    const after = deriveProfile([obs({ principal: "a", tool: "t" })], rejected);
    assert.equal(after.find((r) => r.id === ruleId("a", "t"))!.status, "rejected");
  });

  it("refreshes a still-suggested rule from new traffic", () => {
    let rules = deriveProfile([obs({ principal: "a", tool: "t", service: "s1" })]);
    rules = deriveProfile([obs({ principal: "a", tool: "t", service: "s2" })], rules);
    assert.deepEqual(rules.find((r) => r.id === ruleId("a", "t"))!.constraints.service, ["s2"]);
  });
});

describe("evaluateCall", () => {
  const rules: ProfileRule[] = [{
    id: ruleId("alice", "query_logs"), subject: "alice", tool: "query_logs",
    constraints: { service: ["pay", "order"], argShape: { window: ["<=1h", "<=5m"] } },
    status: "accepted", provenance: { learnedFrom: 5, firstSeen: "x", lastSeen: "y" },
  }];

  const call = (over = {}) => ({ principal: "alice", tool: "query_logs", argShape: {}, ...over });

  it("allows a call within an accepted rule", () => {
    const r = evaluateCall(call({ service: "pay", argShape: { window: "<=1h" } }), rules);
    assert.equal(r.verdict, "allow");
  });

  it("flags a new resource value outside the rule", () => {
    const r = evaluateCall(call({ service: "secret-svc" }), rules);
    assert.equal(r.verdict, "deviation");
    assert.equal(r.kind, "new-resource");
    assert.match(r.detail!, /service=secret-svc/);
  });

  it("flags an arg bucket outside the learned range", () => {
    const r = evaluateCall(call({ service: "pay", argShape: { window: ">1d" } }), rules);
    assert.equal(r.kind, "arg-out-of-range");
  });

  it("flags a known principal reaching for a new tool", () => {
    const r = evaluateCall(call({ tool: "enrich_ips" }), rules);
    assert.equal(r.kind, "new-tool");
  });

  it("flags a wholly-new principal", () => {
    const r = evaluateCall(call({ principal: "mallory" }), rules);
    assert.equal(r.kind, "new-principal");
  });

  it("ignores suggested/rejected rules (only accepted gate)", () => {
    const sugg: ProfileRule[] = [{ ...rules[0], status: "suggested" }];
    assert.equal(evaluateCall(call({ service: "pay", argShape: { window: "<=1h" } }), sugg).kind, "new-principal");
  });

  it("honours a wildcard subject rule", () => {
    const wild: ProfileRule[] = [{ ...rules[0], subject: "*" }];
    assert.equal(evaluateCall(call({ principal: "anyone", service: "pay", argShape: { window: "<=5m" } }), wild).verdict, "allow");
  });
});
