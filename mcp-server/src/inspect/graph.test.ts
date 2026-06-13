import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFlowGraph, backendOf } from "./graph.js";
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

describe("backendOf", () => {
  it("prefers service > source > namespace > (unrouted)", () => {
    assert.equal(backendOf(obs({ service: "pay", source: "p", namespace: "n" })), "pay");
    assert.equal(backendOf(obs({ source: "p", namespace: "n" })), "p");
    assert.equal(backendOf(obs({ namespace: "n" })), "n");
    assert.equal(backendOf(obs({})), "(unrouted)");
  });
});

describe("buildFlowGraph", () => {
  it("builds identity→tool→backend nodes and edges", () => {
    const g = buildFlowGraph([
      obs({ principal: "alice", tool: "query_logs", service: "pay" }),
      obs({ principal: "alice", tool: "query_logs", service: "pay" }),
      obs({ principal: "bob", tool: "query_metrics", source: "prom" }),
    ]);
    assert.equal(g.total, 3);
    const kinds = g.nodes.reduce<Record<string, number>>((m, n) => ((m[n.kind] = (m[n.kind] || 0) + 1), m), {});
    assert.equal(kinds.identity, 2);
    assert.equal(kinds.tool, 2);
    assert.equal(kinds.backend, 2);
    // alice→query_logs edge has count 2
    const e = g.edges.find((x) => x.from === "identity:alice" && x.to === "tool:query_logs");
    assert.equal(e?.count, 2);
    assert.equal(e?.allow, 2);
  });

  it("breaks edges down by decision and counts node errors/deviations", () => {
    const g = buildFlowGraph([
      obs({ principal: "a", tool: "t", service: "s", decision: "allow", outcome: "ok" }),
      obs({ principal: "a", tool: "t", service: "s", decision: "would-block", outcome: "ok" }),
      obs({ principal: "a", tool: "t", service: "s", decision: "blocked", outcome: "error" }),
    ]);
    const e = g.edges.find((x) => x.from === "tool:t" && x.to === "backend:s")!;
    assert.equal(e.allow, 1);
    assert.equal(e.deviation, 1);
    assert.equal(e.denied, 1);
    const toolNode = g.nodes.find((n) => n.id === "tool:t")!;
    assert.equal(toolNode.calls, 3);
    assert.equal(toolNode.errors, 1);
    assert.equal(toolNode.deviations, 2); // would-block + blocked
  });

  it("honours the sinceMs window filter", () => {
    const old = obs({ ts: new Date(1_000_000_000_000).toISOString(), tool: "old" });
    const fresh = obs({ ts: new Date(1_700_000_500_000).toISOString(), tool: "fresh" });
    const g = buildFlowGraph([old, fresh], { sinceMs: 1_700_000_000_000 });
    assert.equal(g.total, 1);
    assert.ok(g.nodes.some((n) => n.id === "tool:fresh"));
    assert.ok(!g.nodes.some((n) => n.id === "tool:old"));
  });

  it("empty input yields an empty graph", () => {
    const g = buildFlowGraph([]);
    assert.deepEqual(g.nodes, []);
    assert.deepEqual(g.edges, []);
    assert.equal(g.total, 0);
  });
});
