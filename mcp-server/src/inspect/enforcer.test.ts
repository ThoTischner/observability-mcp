import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInspectEnforcer } from "./enforcer.js";
import { InspectStore } from "./store.js";
import { ModeController } from "./mode.js";
import type { HookContext } from "../sdk/hooks.js";

const ctx = (over: Partial<HookContext> = {}): HookContext => ({
  principal: "key:bot", tenant: "default", kind: "tool_pre_invoke", target: "query_logs", ...over,
});
const allowEval = { evaluate: () => ({ verdict: "allow" as const }) };
const denyEval = { evaluate: () => ({ verdict: "deviation" as const, kind: "new-resource" }) };

describe("createInspectEnforcer", () => {
  it("registers as a permissive tool_pre_invoke hook", () => {
    const reg = createInspectEnforcer(new InspectStore(), new ModeController("enforce"), allowEval);
    assert.equal(reg.kind, "tool_pre_invoke");
    assert.equal(reg.mode, "permissive");
    assert.equal(reg.pluginName, "inspect-enforcer");
  });

  it("enforce: BLOCKS a deviation and records a blocked observation", async () => {
    const store = new InspectStore();
    const reg = createInspectEnforcer(store, new ModeController("enforce"), denyEval);
    const r = await reg.handler(ctx({ target: "query_logs" }), { args: { service: "novel" } });
    assert.equal(r.allow, false);
    assert.match(r.reason!, /Blocked by the inspection profile/);
    assert.match(r.reason!, /new-resource/);
    const o = store.all()[0];
    assert.equal(o.decision, "blocked");
    assert.equal(o.deviation, "new-resource");
    assert.equal(o.tool, "query_logs");
  });

  it("enforce: ALLOWS an in-profile call and records nothing (post-invoke recorder will)", async () => {
    const store = new InspectStore();
    const reg = createInspectEnforcer(store, new ModeController("enforce"), allowEval);
    const r = await reg.handler(ctx(), { args: {} });
    assert.deepEqual(r, { allow: true });
    assert.equal(store.size, 0);
  });

  it("observe + dry-run never block (pass-through, no eval)", async () => {
    for (const mode of ["off", "observe", "dryrun"] as const) {
      let consulted = false;
      const evaluator = { evaluate: () => { consulted = true; return { verdict: "deviation" as const, kind: "new-tool" }; } };
      const store = new InspectStore();
      const reg = createInspectEnforcer(store, new ModeController(mode), evaluator);
      const r = await reg.handler(ctx(), { args: {} });
      assert.deepEqual(r, { allow: true }, `mode=${mode} must pass through`);
      assert.equal(consulted, false, `mode=${mode} must not evaluate`);
      assert.equal(store.size, 0);
    }
  });

  it("never blocks when the enforce entitlement is absent (enforceAllowed=false)", async () => {
    const store = new InspectStore();
    const reg = createInspectEnforcer(store, new ModeController("enforce"), denyEval, { enforceAllowed: () => false });
    const r = await reg.handler(ctx(), { args: { service: "novel" } });
    assert.deepEqual(r, { allow: true }, "unlicensed enforce must not block");
    assert.equal(store.size, 0, "nothing recorded as blocked when unlicensed");
  });

  it("blocks when the enforce entitlement is present (enforceAllowed=true)", async () => {
    const reg = createInspectEnforcer(new InspectStore(), new ModeController("enforce"), denyEval, { enforceAllowed: () => true });
    const r = await reg.handler(ctx(), { args: {} });
    assert.equal(r.allow, false);
  });

  it("fails OPEN — an evaluator that throws never blocks the call", async () => {
    const store = new InspectStore();
    const boom = { evaluate: () => { throw new Error("inspector bug"); } };
    const reg = createInspectEnforcer(store, new ModeController("enforce"), boom);
    const r = await reg.handler(ctx(), { args: {} });
    assert.deepEqual(r, { allow: true });
  });

  it("fires the onEvent metrics seam on a block", async () => {
    const seen: Array<{ tool: string; decision: string }> = [];
    const reg = createInspectEnforcer(new InspectStore(), new ModeController("enforce"), denyEval, {
      onEvent: (e) => seen.push(e),
    });
    await reg.handler(ctx({ target: "enrich_ips" }), { args: {} });
    assert.deepEqual(seen, [{ tool: "enrich_ips", outcome: "error", decision: "blocked" }]);
  });
});
