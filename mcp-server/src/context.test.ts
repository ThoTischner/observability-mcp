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

test("defaultContext — no allowedTools (anonymous sees every tool, back-compat)", () => {
  const ctx = defaultContext();
  assert.equal(ctx.allowedTools, undefined);
  assert.equal(allowsTool(ctx.allowedTools, "any_tool"), true);
});
