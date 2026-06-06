import { test } from "node:test";
import assert from "node:assert/strict";

import { HookRegistry } from "./hooks.js";
import {
  wrapToolHandler,
  wrapResourceHandler,
  wrapPromptHandler,
  type HookCtxBase,
} from "./hook-wrappers.js";

const CTX: HookCtxBase = { principal: "alice", tenant: "default", target: "x" };

// --- tool ------------------------------------------------------------

test("wrapToolHandler: no hooks → pass-through", async () => {
  const reg = new HookRegistry();
  const wrapped = wrapToolHandler(reg, CTX, async (args) => ({ content: [{ type: "text", text: `got ${JSON.stringify(args)}` }] }));
  const r = await wrapped({ q: 1 }, undefined);
  assert.deepEqual(r, { content: [{ type: "text", text: 'got {"q":1}' }] });
});

test("wrapToolHandler: pre-invoke denial → isError + reason; handler NOT called", async () => {
  const reg = new HookRegistry();
  let called = false;
  reg.register({
    pluginName: "guard",
    kind: "tool_pre_invoke",
    handler: () => ({ allow: false, reason: "blocked" }),
  });
  const wrapped = wrapToolHandler(reg, CTX, async () => {
    called = true;
    return { content: [] };
  });
  const r = await wrapped({}, undefined);
  assert.equal(called, false);
  assert.deepEqual(r, { content: [{ type: "text", text: "blocked" }], isError: true });
});

test("wrapToolHandler: pre-invoke args mutation flows into handler", async () => {
  const reg = new HookRegistry();
  reg.register({
    pluginName: "enrich",
    kind: "tool_pre_invoke",
    handler: (_ctx, payload) => ({
      allow: true,
      payload: { args: { ...(payload.args as object), injected: true } },
    }),
  });
  let observedArgs: unknown;
  const wrapped = wrapToolHandler(reg, CTX, async (args) => {
    observedArgs = args;
    return { content: [] };
  });
  await wrapped({ original: 1 }, undefined);
  assert.deepEqual(observedArgs, { original: 1, injected: true });
});

test("wrapToolHandler: post-invoke result mutation flows back to caller", async () => {
  const reg = new HookRegistry();
  reg.register({
    pluginName: "redact",
    kind: "tool_post_invoke",
    handler: () => ({ allow: true, payload: { result: { content: [{ type: "text", text: "REDACTED" }] } } }),
  });
  const wrapped = wrapToolHandler(reg, CTX, async () => ({
    content: [{ type: "text", text: "secret-value" }],
  }));
  const r = await wrapped({}, undefined);
  assert.deepEqual(r, { content: [{ type: "text", text: "REDACTED" }] });
});

// --- resource --------------------------------------------------------

test("wrapResourceHandler: no hooks → pass-through with original URI", async () => {
  const reg = new HookRegistry();
  let observed: unknown;
  const wrapped = wrapResourceHandler(reg, CTX, async (uri) => {
    observed = uri;
    return { contents: [{ uri: String(uri), text: "hi" }] };
  });
  const r = await wrapped("file:///a", undefined);
  assert.equal(observed, "file:///a");
  assert.deepEqual(r, { contents: [{ uri: "file:///a", text: "hi" }] });
});

test("wrapResourceHandler: pre-fetch denial returns structured error; handler NOT called", async () => {
  const reg = new HookRegistry();
  let called = false;
  reg.register({
    pluginName: "guard",
    kind: "resource_pre_fetch",
    handler: () => ({ allow: false, reason: "forbidden uri" }),
  });
  const wrapped = wrapResourceHandler(reg, CTX, async () => {
    called = true;
    return { contents: [] };
  });
  const r = await wrapped("file:///secret", undefined);
  assert.equal(called, false);
  assert.deepEqual(r, {
    contents: [{ uri: "file:///secret", mimeType: "text/plain", text: "forbidden uri" }],
    isError: true,
  });
});

test("wrapResourceHandler: pre-fetch URI mutation flows into handler", async () => {
  const reg = new HookRegistry();
  reg.register({
    pluginName: "canon",
    kind: "resource_pre_fetch",
    handler: () => ({ allow: true, payload: { uri: "file:///canonical" } }),
  });
  let observed: unknown;
  const wrapped = wrapResourceHandler(reg, CTX, async (uri) => {
    observed = uri;
    return { contents: [{ uri: String(uri), text: "ok" }] };
  });
  await wrapped("file:///raw", undefined);
  assert.equal(observed, "file:///canonical");
});

test("wrapResourceHandler: URL instance preserved across mutation", async () => {
  const reg = new HookRegistry();
  reg.register({
    pluginName: "canon",
    kind: "resource_pre_fetch",
    handler: () => ({ allow: true, payload: { uri: "https://new.example/path" } }),
  });
  let observed: unknown;
  const wrapped = wrapResourceHandler(reg, CTX, async (uri) => {
    observed = uri;
    return { contents: [{ uri: String(uri), text: "ok" }] };
  });
  await wrapped(new URL("https://old.example/path"), undefined);
  assert.ok(observed instanceof URL, "mutated URI should still be a URL when caller passed one");
  assert.equal(String(observed), "https://new.example/path");
});

test("wrapResourceHandler: post-fetch contents replacement", async () => {
  const reg = new HookRegistry();
  reg.register({
    pluginName: "censor",
    kind: "resource_post_fetch",
    handler: () => ({ allow: true, payload: { contents: [{ uri: "file:///x", text: "[censored]" }] } }),
  });
  const wrapped = wrapResourceHandler(reg, CTX, async () => ({
    contents: [{ uri: "file:///x", text: "raw" }],
    _meta: { kept: true },
  }));
  const r = (await wrapped("file:///x", undefined)) as { contents: unknown; _meta: unknown };
  assert.deepEqual(r.contents, [{ uri: "file:///x", text: "[censored]" }]);
  // Other top-level keys survive the mutation
  assert.deepEqual(r._meta, { kept: true });
});

// --- prompt ----------------------------------------------------------

test("wrapPromptHandler: no hooks → pass-through", async () => {
  const reg = new HookRegistry();
  const wrapped = wrapPromptHandler(reg, { ...CTX, target: "greet" }, async (args) => ({
    description: "ok",
    messages: [{ role: "user", content: { type: "text", text: `hi ${JSON.stringify(args)}` } }],
  }));
  const r = await wrapped({ who: "world" }, undefined);
  assert.deepEqual(r, {
    description: "ok",
    messages: [{ role: "user", content: { type: "text", text: 'hi {"who":"world"}' } }],
  });
});

test("wrapPromptHandler: pre-fetch denial returns structured error; handler NOT called", async () => {
  const reg = new HookRegistry();
  let called = false;
  reg.register({
    pluginName: "guard",
    kind: "prompt_pre_fetch",
    handler: () => ({ allow: false, reason: "denied" }),
  });
  const wrapped = wrapPromptHandler(reg, CTX, async () => {
    called = true;
    return { description: "x", messages: [] };
  });
  const r = await wrapped({}, undefined);
  assert.equal(called, false);
  assert.deepEqual(r, { description: "denied", messages: [], isError: true });
});

test("wrapPromptHandler: pre-fetch arguments mutation flows into handler", async () => {
  const reg = new HookRegistry();
  reg.register({
    pluginName: "augment",
    kind: "prompt_pre_fetch",
    handler: (_ctx, payload) => ({
      allow: true,
      payload: { name: (payload as { name: string }).name, arguments: { ...(payload.arguments as object), extra: 1 } },
    }),
  });
  let observed: unknown;
  const wrapped = wrapPromptHandler(reg, CTX, async (args) => {
    observed = args;
    return { description: "", messages: [] };
  });
  await wrapped({ original: true }, undefined);
  assert.deepEqual(observed, { original: true, extra: 1 });
});

test("wrapPromptHandler: post-fetch messages replacement", async () => {
  const reg = new HookRegistry();
  reg.register({
    pluginName: "rewrite",
    kind: "prompt_post_fetch",
    handler: () => ({
      allow: true,
      payload: {
        messages: [{ role: "system", content: { type: "text", text: "rewritten" } }],
      },
    }),
  });
  const wrapped = wrapPromptHandler(reg, CTX, async () => ({
    description: "ok",
    messages: [{ role: "user", content: { type: "text", text: "raw" } }],
  }));
  const r = (await wrapped({}, undefined)) as { description: string; messages: unknown };
  assert.equal(r.description, "ok");
  assert.deepEqual(r.messages, [{ role: "system", content: { type: "text", text: "rewritten" } }]);
});
