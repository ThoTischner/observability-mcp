import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProfileStore } from "./profile-store.js";
import { ruleId } from "./profile.js";
import type { Observation } from "./store.js";

let seq = 0;
function obs(over: Partial<Observation> = {}): Observation {
  return {
    ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    seq: ++seq,
    principal: "key:bot", auth: "apikey", tenant: "default", tool: "query_logs",
    argShape: {}, outcome: "ok", decision: "allow", redactions: 0, ...over,
  };
}

describe("ProfileStore", () => {
  it("derive → setStatus(accept) → evaluate allows learned, flags novel", () => {
    const s = new ProfileStore();
    s.derive([obs({ principal: "a", tool: "query_logs", service: "pay", argShape: { window: "<=1h" } })]);
    assert.equal(s.suggested().length, 1);
    assert.equal(s.accepted().length, 0);
    const id = ruleId("a", "query_logs");
    s.setStatus(id, "accepted");
    assert.equal(s.accepted().length, 1);

    assert.equal(s.evaluate({ principal: "a", tool: "query_logs", service: "pay", argShape: { window: "<=1h" } }).verdict, "allow");
    assert.equal(s.evaluate({ principal: "a", tool: "query_logs", service: "x", argShape: {} }).kind, "new-resource");
  });

  it("setStatus/remove return null/false for unknown ids", () => {
    const s = new ProfileStore();
    assert.equal(s.setStatus("nope", "accepted"), null);
    assert.equal(s.remove("nope"), false);
  });

  it("update replaces constraints", () => {
    const s = new ProfileStore();
    s.derive([obs({ principal: "a", tool: "t", service: "s1" })]);
    const id = ruleId("a", "t");
    s.update(id, { constraints: { service: ["s1", "s2"] } });
    assert.deepEqual(s.list().find((r) => r.id === id)!.constraints.service, ["s1", "s2"]);
  });

  it("persists via the writer seam and reloads via the reader seam", () => {
    let blob = "";
    const a = new ProfileStore({ file: "profile-store-test.json", reader: () => { throw new Error("absent"); }, writer: (_f, d) => { blob = d; } });
    a.derive([obs({ principal: "a", tool: "t", service: "s" })]);
    a.setStatus(ruleId("a", "t"), "accepted");
    assert.ok(blob.includes('"accepted"'));
    // a fresh store reads it back
    const b = new ProfileStore({ file: "profile-store-test.json", reader: () => blob, writer: () => {} });
    assert.equal(b.accepted().length, 1);
    assert.equal(b.persisted, true);
  });

  it("absorb: creates a tight accepted rule for a brand-new deviation", () => {
    const s = new ProfileStore();
    const r = s.absorb({ principal: "mallory", tool: "query_logs", service: "pay", argShape: { window: "<=1h" } });
    assert.equal(r.status, "accepted");
    assert.deepEqual(r.constraints.service, ["pay"]);
    assert.deepEqual(r.constraints.argShape!.window, ["<=1h"]);
    // that exact call is now allowed
    assert.equal(s.evaluate({ principal: "mallory", tool: "query_logs", service: "pay", argShape: { window: "<=1h" } }).verdict, "allow");
  });

  it("absorb: widens an existing accepted rule (sorted union, no dupes)", () => {
    const s = new ProfileStore();
    s.absorb({ principal: "a", tool: "t", service: "s1", argShape: {} });
    const r = s.absorb({ principal: "a", tool: "t", service: "s2", argShape: {} });
    assert.deepEqual(r.constraints.service, ["s1", "s2"]);
    // idempotent
    const r2 = s.absorb({ principal: "a", tool: "t", service: "s2", argShape: {} });
    assert.deepEqual(r2.constraints.service, ["s1", "s2"]);
    assert.equal(s.list().filter((x) => x.id === ruleId("a", "t")).length, 1);
  });

  it("absorb: flips a previously-rejected/suggested rule to accepted", () => {
    const s = new ProfileStore();
    s.derive([obs({ principal: "a", tool: "t", service: "s1" })]); // suggested
    s.setStatus(ruleId("a", "t"), "rejected");
    const r = s.absorb({ principal: "a", tool: "t", service: "s9", argShape: {} });
    assert.equal(r.status, "accepted");
    assert.deepEqual(r.constraints.service, ["s1", "s9"]);
  });

  it("a missing/invalid file starts empty, never throws", () => {
    assert.doesNotThrow(() => {
      const s = new ProfileStore({ file: "profile-store-missing.json", reader: () => "not json{", writer: () => {} });
      assert.equal(s.size, 0);
    });
  });
});
