import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InspectStore } from "./store.js";

function mk(over: Partial<Parameters<InspectStore["record"]>[0]> = {}) {
  return {
    principal: "key:bot",
    auth: "apikey",
    tenant: "default",
    tool: "query_logs",
    argShape: {},
    outcome: "ok" as const,
    decision: "allow" as const,
    redactions: 0,
    ...over,
  };
}

describe("InspectStore", () => {
  it("assigns ts + monotonic seq and returns the stored observation", () => {
    let t = 1_700_000_000_000;
    const s = new InspectStore({ now: () => t });
    const a = s.record(mk());
    t += 1000;
    const b = s.record(mk());
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    assert.ok(a.ts < b.ts);
    assert.equal(s.size, 2);
  });

  it("rings out the oldest beyond cap", () => {
    const s = new InspectStore({ cap: 3 });
    for (let i = 0; i < 5; i++) s.record(mk({ tool: `t${i}` }));
    assert.equal(s.size, 3);
    const tools = s.all().map((o) => o.tool);
    assert.deepEqual(tools, ["t2", "t3", "t4"]);
  });

  it("filters by principal / tool / outcome / decision, newest-first", () => {
    const s = new InspectStore();
    s.record(mk({ principal: "a", tool: "query_logs", outcome: "ok" }));
    s.record(mk({ principal: "b", tool: "query_metrics", outcome: "error" }));
    s.record(mk({ principal: "a", tool: "query_metrics", decision: "would-block" }));

    assert.equal(s.list({ principal: "a" }).length, 2);
    assert.equal(s.list({ tool: "query_metrics" }).length, 2);
    assert.equal(s.list({ outcome: "error" }).length, 1);
    assert.equal(s.list({ decision: "would-block" }).length, 1);
    // newest first
    assert.equal(s.list({ principal: "a" })[0].decision, "would-block");
  });

  it("respects limit", () => {
    const s = new InspectStore();
    for (let i = 0; i < 10; i++) s.record(mk());
    assert.equal(s.list({ limit: 4 }).length, 4);
  });

  it("since() returns observations at/after a cutoff", () => {
    let t = 1_700_000_000_000;
    const s = new InspectStore({ now: () => t });
    s.record(mk({ tool: "old" }));
    t += 60_000;
    const cut = t;
    t += 1000;
    s.record(mk({ tool: "new" }));
    const recent = s.since(cut);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].tool, "new");
  });

  it("mirrors to the file appender when configured; never throws on append failure", () => {
    const lines: string[] = [];
    const s = new InspectStore({ file: "inspect-store-test.jsonl", appender: async (_f, l) => { lines.push(l); } });
    assert.equal(s.persisted, true);
    s.record(mk({ tool: "logged" }));
    // appender is fire-and-forget; the line is queued synchronously here
    assert.equal(lines.length, 1);
    assert.match(lines[0], /"tool":"logged"/);

    const boom = new InspectStore({ file: "inspect-store-test.jsonl", appender: async () => { throw new Error("disk full"); } });
    assert.doesNotThrow(() => boom.record(mk()));
  });
});
