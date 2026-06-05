import { test } from "node:test";
import assert from "node:assert/strict";

import { HookRegistry, type HookContext, type HookResult } from "./hooks.js";

function ctx(target = "list_services"): HookContext {
  return {
    principal: "alice",
    tenant: "default",
    kind: "tool_pre_invoke",
    target,
  };
}

test("HookRegistry.register: adds an entry with defaults applied", () => {
  const r = new HookRegistry();
  r.register({
    pluginName: "p1",
    kind: "tool_pre_invoke",
    handler: () => ({ allow: true }),
  });
  const list = r.list("tool_pre_invoke");
  assert.equal(list.length, 1);
  assert.equal(list[0]?.priority, 100);
  assert.equal(list[0]?.mode, "enforce");
});

test("HookRegistry.register: re-registering same (plugin,kind) replaces prior entry", () => {
  const r = new HookRegistry();
  r.register({ pluginName: "p", kind: "tool_pre_invoke", priority: 10, handler: () => ({ allow: true }) });
  r.register({ pluginName: "p", kind: "tool_pre_invoke", priority: 20, handler: () => ({ allow: true }) });
  const list = r.list("tool_pre_invoke");
  assert.equal(list.length, 1);
  assert.equal(list[0]?.priority, 20);
});

test("HookRegistry.list: orders by priority (lower runs first)", () => {
  const r = new HookRegistry();
  r.register({ pluginName: "a", kind: "tool_pre_invoke", priority: 50, handler: () => ({ allow: true }) });
  r.register({ pluginName: "b", kind: "tool_pre_invoke", priority: 10, handler: () => ({ allow: true }) });
  r.register({ pluginName: "c", kind: "tool_pre_invoke", priority: 99, handler: () => ({ allow: true }) });
  const names = r.list("tool_pre_invoke").map((e) => e.pluginName);
  assert.deepEqual(names, ["b", "a", "c"]);
});

test("HookRegistry.list: disabled hooks are filtered out", () => {
  const r = new HookRegistry();
  r.register({ pluginName: "a", kind: "tool_pre_invoke", handler: () => ({ allow: true }) });
  r.register({ pluginName: "b", kind: "tool_pre_invoke", mode: "disabled", handler: () => ({ allow: true }) });
  const names = r.list("tool_pre_invoke").map((e) => e.pluginName);
  assert.deepEqual(names, ["a"]);
});

test("HookRegistry.unregisterPlugin: drops every entry for a plugin", () => {
  const r = new HookRegistry();
  r.register({ pluginName: "p", kind: "tool_pre_invoke", handler: () => ({ allow: true }) });
  r.register({ pluginName: "p", kind: "tool_post_invoke", handler: () => ({ allow: true }) });
  r.register({ pluginName: "q", kind: "tool_pre_invoke", handler: () => ({ allow: true }) });
  const dropped = r.unregisterPlugin("p");
  assert.equal(dropped, 2);
  assert.equal(r.all().length, 1);
  assert.equal(r.all()[0]?.pluginName, "q");
});

test("HookRegistry.fire: chains payload mutations and returns the final", async () => {
  const r = new HookRegistry();
  r.register({
    pluginName: "a",
    kind: "tool_pre_invoke",
    priority: 10,
    handler: (_c, p) => ({ allow: true, payload: { ...p, a: 1 } }),
  });
  r.register({
    pluginName: "b",
    kind: "tool_pre_invoke",
    priority: 20,
    handler: (_c, p) => ({ allow: true, payload: { ...p, b: 2 } }),
  });
  const result = await r.fire("tool_pre_invoke", ctx(), { initial: true });
  assert.equal(result.allow, true);
  assert.deepEqual(result.payload, { initial: true, a: 1, b: 2 });
});

test("HookRegistry.fire: first allow:false short-circuits subsequent hooks", async () => {
  const r = new HookRegistry();
  let sawSecond = false;
  r.register({
    pluginName: "a",
    kind: "tool_pre_invoke",
    priority: 10,
    handler: () => ({ allow: false, reason: "denied by policy" }),
  });
  r.register({
    pluginName: "b",
    kind: "tool_pre_invoke",
    priority: 20,
    handler: () => {
      sawSecond = true;
      return { allow: true };
    },
  });
  const result = await r.fire("tool_pre_invoke", ctx(), {});
  assert.equal(result.allow, false);
  assert.equal(result.reason, "denied by policy");
  assert.equal(sawSecond, false);
});

test("HookRegistry.fire: enforce-mode throw blocks the chain", async () => {
  const r = new HookRegistry();
  let sawSecond = false;
  r.register({
    pluginName: "a",
    kind: "tool_pre_invoke",
    handler: () => {
      throw new Error("boom");
    },
  });
  r.register({
    pluginName: "b",
    kind: "tool_pre_invoke",
    priority: 200,
    handler: () => {
      sawSecond = true;
      return { allow: true };
    },
  });
  const result = await r.fire("tool_pre_invoke", ctx(), {});
  assert.equal(result.allow, false);
  assert.match(result.reason ?? "", /boom/);
  assert.equal(sawSecond, false);
});

test("HookRegistry.fire: permissive-mode throw is logged + chain continues with prior payload", async () => {
  const r = new HookRegistry();
  r.register({
    pluginName: "a",
    kind: "tool_pre_invoke",
    priority: 10,
    handler: (_c, p) => ({ allow: true, payload: { ...p, a: 1 } }),
  });
  r.register({
    pluginName: "b",
    kind: "tool_pre_invoke",
    priority: 20,
    mode: "permissive",
    handler: () => {
      throw new Error("intermittent failure");
    },
  });
  r.register({
    pluginName: "c",
    kind: "tool_pre_invoke",
    priority: 30,
    handler: (_c, p) => ({ allow: true, payload: { ...p, c: 3 } }),
  });
  const logs: string[] = [];
  const result = await r.fire("tool_pre_invoke", ctx(), {}, (lvl, m) => {
    if (lvl === "warn") logs.push(m);
  });
  assert.equal(result.allow, true);
  assert.deepEqual(result.payload, { a: 1, c: 3 });
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /b\/tool_pre_invoke/);
});

test("HookRegistry.fire: no hooks => allow with the initial payload", async () => {
  const r = new HookRegistry();
  const result = await r.fire("tool_pre_invoke", ctx(), { x: 1 });
  assert.deepEqual(result, { allow: true, payload: { x: 1 } });
});
