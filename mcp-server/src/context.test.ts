import { test } from "node:test";
import assert from "node:assert/strict";

import { allowsTool, intersectAllowed, defaultContext, principalContext } from "./context.js";

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

// intersectAllowed folds a per-credential list (OMCP_KEY_TOOLS) with a Product
// list — most-restrictive wins.
test("intersectAllowed — either side undefined returns the other (no widening)", () => {
  assert.equal(intersectAllowed(undefined, undefined), undefined);
  assert.deepEqual(intersectAllowed(["a", "b"], undefined), ["a", "b"]);
  assert.deepEqual(intersectAllowed(undefined, ["a", "b"]), ["a", "b"]);
});

test("intersectAllowed — both set → intersection only", () => {
  assert.deepEqual(intersectAllowed(["query_logs", "list_services"], ["query_logs", "get_topology"]), ["query_logs"]);
  // Disjoint → empty list: the credential can call nothing through that binding.
  assert.deepEqual(intersectAllowed(["query_logs"], ["get_topology"]), []);
  // Order follows the first (credential) list.
  assert.deepEqual(intersectAllowed(["b", "a"], ["a", "b"]), ["b", "a"]);
});

// The registration gate ANDs two independent allowsTool axes (Product +
// per-credential OMCP_KEY_TOOLS). This is what makes disjoint lists deny
// everything WITHOUT routing through an overloaded empty intersection — an
// empty `[]` would be read by allowsTool as "allow all", which is why the two
// axes are kept separate rather than pre-intersected into one list.
function passesGate(productTools: string[] | undefined, credTools: string[] | undefined, name: string): boolean {
  return allowsTool(productTools, name) && allowsTool(credTools, name);
}

test("two-axis gate — disjoint Product and credential lists deny every tool", () => {
  // Product allows get_topology; credential allows only query_logs → nothing passes.
  assert.equal(passesGate(["get_topology"], ["query_logs"], "query_logs"), false);
  assert.equal(passesGate(["get_topology"], ["query_logs"], "get_topology"), false);
});

test("two-axis gate — credential list narrows within an unrestricted Product axis", () => {
  assert.equal(passesGate(undefined, ["query_logs"], "query_logs"), true);
  assert.equal(passesGate(undefined, ["query_logs"], "get_topology"), false);
});

test("two-axis gate — overlapping lists allow only the overlap", () => {
  const product = ["query_logs", "get_topology", "list_services"];
  const cred = ["query_logs", "list_services"];
  assert.equal(passesGate(product, cred, "query_logs"), true);
  assert.equal(passesGate(product, cred, "list_services"), true);
  assert.equal(passesGate(product, cred, "get_topology"), false); // in Product, not in credential
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
