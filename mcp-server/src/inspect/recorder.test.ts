import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInspectRecorder, isErrorResult, authKind } from "./recorder.js";
import { InspectStore } from "./store.js";
import { ModeController } from "./mode.js";
import type { HookContext } from "../sdk/hooks.js";

const ctx = (over: Partial<HookContext> = {}): HookContext => ({
  principal: "key:bot",
  tenant: "default",
  kind: "tool_post_invoke",
  target: "query_logs",
  ...over,
});

describe("recorder helpers", () => {
  it("isErrorResult detects MCP error envelopes", () => {
    assert.equal(isErrorResult({ isError: true }), true);
    assert.equal(isErrorResult({ isError: false }), false);
    assert.equal(isErrorResult({ content: [] }), false);
    assert.equal(isErrorResult(null), false);
  });
  it("authKind infers from principal", () => {
    assert.equal(authKind("anonymous"), "anonymous");
    assert.equal(authKind("key:bot"), "apikey");
  });
});

describe("createInspectRecorder", () => {
  it("registers as a permissive tool_post_invoke hook", () => {
    const reg = createInspectRecorder(new InspectStore(), new ModeController("observe"));
    assert.equal(reg.kind, "tool_post_invoke");
    assert.equal(reg.mode, "permissive");
    assert.equal(reg.pluginName, "inspect-recorder");
  });

  it("records an observation with a derived signature and always allows", async () => {
    const store = new InspectStore();
    const reg = createInspectRecorder(store, new ModeController("observe"));
    const r = await reg.handler(
      ctx({ target: "query_logs" }),
      { args: { source: "prom-eu", service: "pay", query: "rate(x[5m])", window: "1h" }, result: { content: [] } },
    );
    assert.deepEqual(r, { allow: true });
    assert.equal(store.size, 1);
    const o = store.all()[0];
    assert.equal(o.tool, "query_logs");
    assert.equal(o.source, "prom-eu");
    assert.equal(o.service, "pay");
    assert.equal(o.argShape.window, "<=1h");
    assert.equal(o.argShape.query, "present"); // literal never stored
    assert.equal(o.decision, "allow");
    assert.equal(o.outcome, "ok");
  });

  it("redacts secrets out of args before shaping (no PII leaks into the store)", async () => {
    const store = new InspectStore();
    const reg = createInspectRecorder(store, new ModeController("observe"));
    await reg.handler(
      ctx(),
      { args: { note: "contact ops@example.com token AKIAIOSFODNN7EXAMPLE" }, result: {} },
    );
    const o = store.all()[0];
    assert.ok(o.redactions >= 1, "redactor ran");
    // the value collapses to "present"; literal never persisted regardless
    assert.equal(o.argShape.note, "present");
    assert.ok(!JSON.stringify(o).includes("AKIA"));
  });

  it("marks error outcomes from isError results", async () => {
    const store = new InspectStore();
    const reg = createInspectRecorder(store, new ModeController("observe"));
    await reg.handler(ctx(), { args: {}, result: { isError: true } });
    assert.equal(store.all()[0].outcome, "error");
  });

  it("records nothing when mode is off", async () => {
    const store = new InspectStore();
    const reg = createInspectRecorder(store, new ModeController("off"));
    await reg.handler(ctx(), { args: {}, result: {} });
    assert.equal(store.size, 0);
  });

  it("never throws and still allows even if shaping blows up", async () => {
    const store = new InspectStore();
    const reg = createInspectRecorder(store, new ModeController("observe"));
    // circular args would throw in JSON paths; redactValue handles objects but
    // we assert the contract: handler resolves allow:true regardless.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const r = await reg.handler(ctx(), { args: circular, result: {} });
    assert.deepEqual(r, { allow: true });
  });

  it("dry-run: records would-block + deviation kind for a profile deviation", async () => {
    const store = new InspectStore();
    const evaluator = { evaluate: () => ({ verdict: "deviation" as const, kind: "new-resource" }) };
    const reg = createInspectRecorder(store, new ModeController("dryrun"), { evaluator });
    await reg.handler(ctx({ target: "query_logs" }), { args: { service: "novel" }, result: {} });
    const o = store.all()[0];
    assert.equal(o.decision, "would-block");
    assert.equal(o.deviation, "new-resource");
  });

  it("dry-run: records allow when the call is within profile", async () => {
    const store = new InspectStore();
    const evaluator = { evaluate: () => ({ verdict: "allow" as const }) };
    const reg = createInspectRecorder(store, new ModeController("dryrun"), { evaluator });
    await reg.handler(ctx(), { args: {}, result: {} });
    assert.equal(store.all()[0].decision, "allow");
  });

  it("observe mode never consults the evaluator (always allow)", async () => {
    const store = new InspectStore();
    let consulted = false;
    const evaluator = { evaluate: () => { consulted = true; return { verdict: "deviation" as const, kind: "new-tool" }; } };
    const reg = createInspectRecorder(store, new ModeController("observe"), { evaluator });
    await reg.handler(ctx(), { args: {}, result: {} });
    assert.equal(store.all()[0].decision, "allow");
    assert.equal(consulted, false);
  });

  it("fires the onEvent metrics seam", async () => {
    const seen: Array<{ tool: string; outcome: string; decision: string }> = [];
    const reg = createInspectRecorder(new InspectStore(), new ModeController("observe"), {
      onEvent: (e) => seen.push(e),
    });
    await reg.handler(ctx({ target: "enrich_ips" }), { args: { ips: ["1.2.3.4"] }, result: {} });
    assert.deepEqual(seen, [{ tool: "enrich_ips", outcome: "ok", decision: "allow" }]);
  });
});
