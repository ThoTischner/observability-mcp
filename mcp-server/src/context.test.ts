import { test } from "node:test";
import assert from "node:assert/strict";

import { allowsTool, defaultContext, principalContext } from "./context.js";

test("allowsTool — undefined allow-list = no Product binding = every tool allowed", () => {
  assert.equal(allowsTool(undefined, "list_sources"), true);
  assert.equal(allowsTool(undefined, "query_logs"), true);
});

test("allowsTool — empty allow-list = Product with no tools field = every tool allowed", () => {
  assert.equal(allowsTool([], "list_sources"), true);
});

test("allowsTool — non-empty allow-list gates by exact match", () => {
  const allow = ["list_sources", "query_metrics"];
  assert.equal(allowsTool(allow, "list_sources"), true);
  assert.equal(allowsTool(allow, "query_metrics"), true);
  assert.equal(allowsTool(allow, "query_logs"), false);
  assert.equal(allowsTool(allow, "get_topology"), false);
});

test("allowsTool — case-sensitive (matches MCP spec)", () => {
  const allow = ["list_sources"];
  assert.equal(allowsTool(allow, "List_Sources"), false);
});

test("principalContext — passes allowedTools through; empty array → undefined", () => {
  const ctx1 = principalContext("agent", undefined, { allowedTools: ["query_logs"] });
  assert.deepEqual(ctx1.allowedTools, ["query_logs"]);
  // Empty array carries the "no restriction" semantic — we normalise
  // to undefined so allowsTool() takes the back-compat short path.
  const ctx2 = principalContext("agent", undefined, { allowedTools: [] });
  assert.equal(ctx2.allowedTools, undefined);
  const ctx3 = principalContext("agent");
  assert.equal(ctx3.allowedTools, undefined);
});

test("principalContext — allowRawQuery passes through, off by default (R4 per-credential raw_query)", () => {
  assert.equal(principalContext("agent").allowRawQuery, undefined);
  assert.equal(principalContext("agent", undefined, {}).allowRawQuery, undefined);
  assert.equal(principalContext("agent", undefined, { allowRawQuery: false }).allowRawQuery, undefined);
  assert.equal(principalContext("agent", undefined, { allowRawQuery: true }).allowRawQuery, true);
});

test("defaultContext — no allowedTools (anonymous sees every tool, back-compat)", () => {
  const ctx = defaultContext();
  assert.equal(ctx.allowedTools, undefined);
  assert.equal(allowsTool(ctx.allowedTools, "any_tool"), true);
});

test("defaultContext — allowBypassRedaction is off by default, opt-in via opts (R5, issue #415 Gap A)", () => {
  assert.equal(defaultContext().allowBypassRedaction, undefined);
  assert.equal(defaultContext({}).allowBypassRedaction, undefined);
  assert.equal(defaultContext({ allowBypassRedaction: false }).allowBypassRedaction, undefined);
  assert.equal(defaultContext({ allowBypassRedaction: true }).allowBypassRedaction, true);
});

import { sessionContext } from "./context.js";

test("sessionContext — undefined session → defaultContext shape (anonymous, default tenant)", () => {
  const ctx = sessionContext(undefined);
  assert.equal(ctx.auth, "anonymous");
  assert.equal(ctx.tenant, "default");
  assert.equal(ctx.principalId, "anonymous");
});

test("sessionContext — session.tenant flows into ctx.tenant (the load-bearing property for /api/services + /api/health)", () => {
  const ctx = sessionContext({ sub: "alice", name: "Alice", tenant: "acme" });
  assert.equal(ctx.tenant, "acme");
  assert.equal(ctx.principalId, "alice");
  assert.equal(ctx.auth, "apikey");
});

test("sessionContext — falls back to session.name when sub absent", () => {
  const ctx = sessionContext({ name: "operator-bot", tenant: "bigco" });
  assert.equal(ctx.principalId, "operator-bot");
});

test("sessionContext — sessionless tenant inherits DEFAULT (no leak from a previous tenant'd request)", () => {
  // Belt-and-suspenders: explicit empty tenant string normalises to default.
  const ctx = sessionContext({ sub: "u", tenant: "" });
  assert.equal(ctx.tenant, "default");
});
