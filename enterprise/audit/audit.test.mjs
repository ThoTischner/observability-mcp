import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuditLog, verifyChain, auditDecision, canonical } from "./audit.mjs";

const fixedClock = () => {
  let t = 0;
  return () => `2026-05-18T00:00:${String(t++).padStart(2, "0")}.000Z`;
};

test("canonical: stable key order, recursive, primitives", () => {
  assert.equal(canonical({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonical({ a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4}}');
  assert.equal(canonical([3, { y: 1, x: 2 }]), '[3,{"x":2,"y":1}]');
  assert.equal(canonical("s"), '"s"');
  assert.equal(canonical(null), "null");
});

test("append builds a verifiable hash chain from genesis", async () => {
  const log = createAuditLog({ now: fixedClock() });
  await log.record({ kind: "a" });
  await log.record({ kind: "b" });
  await log.record({ kind: "c" });
  const e = log.entries();
  assert.equal(e.length, 3);
  assert.deepEqual([e[0].seq, e[1].seq, e[2].seq], [0, 1, 2]);
  assert.equal(e[0].prevHash, "0".repeat(64));
  assert.equal(e[1].prevHash, e[0].hash);
  assert.equal(e[2].prevHash, e[1].hash);
  assert.equal(log.verify().ok, true);
  assert.equal(log.head(), e[2].hash);
});

test("modifying any field breaks verification at that entry", async () => {
  const log = createAuditLog({ now: fixedClock() });
  await log.record({ kind: "x", v: 1 });
  await log.record({ kind: "y", v: 2 });
  await log.record({ kind: "z", v: 3 });
  const tampered = log.entries();
  tampered[1].event.v = 999; // silent edit
  const r = verifyChain(tampered);
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt, 1);
  assert.match(r.reason, /tampered/);
});

test("reordering entries is detected", async () => {
  const log = createAuditLog({ now: fixedClock() });
  await log.record({ n: 1 });
  await log.record({ n: 2 });
  const e = log.entries();
  const swapped = [e[1], e[0]];
  const r = verifyChain(swapped);
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt, 0);
});

test("truncating the middle is detected (seq/prevHash gap)", async () => {
  const log = createAuditLog({ now: fixedClock() });
  await log.record({ n: 1 });
  await log.record({ n: 2 });
  await log.record({ n: 3 });
  const e = log.entries();
  const dropped = [e[0], e[2]]; // remove the middle
  const r = verifyChain(dropped);
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt, 1);
});

test("appending a forged entry without the real prevHash is detected", async () => {
  const log = createAuditLog({ now: fixedClock() });
  await log.record({ n: 1 });
  const e = log.entries();
  e.push({ seq: 1, ts: "t", prevHash: "f".repeat(64), event: { forged: true }, hash: "deadbeef" });
  const r = verifyChain(e);
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt, 1);
});

test("sink receives each sealed entry exactly once, in order", async () => {
  const seen = [];
  const log = createAuditLog({ now: fixedClock(), sink: (x) => seen.push(x.event.k) });
  await log.record({ k: "first" });
  await log.record({ k: "second" });
  assert.deepEqual(seen, ["first", "second"]);
  assert.equal(verifyChain(log.entries()).ok, true);
});

test("async sink is awaited", async () => {
  const order = [];
  const log = createAuditLog({
    now: fixedClock(),
    sink: async (x) => { await Promise.resolve(); order.push(x.seq); },
  });
  await log.record({ a: 1 });
  await log.record({ a: 2 });
  assert.deepEqual(order, [0, 1]);
});

test("auditDecision records a consistent access-decision shape", async () => {
  const log = createAuditLog({ now: fixedClock() });
  const ctx = { principalId: "key:bob", auth: "apikey", correlationId: "corr-1" };
  await auditDecision(
    log,
    ctx,
    { tool: "query_metrics", source: "prom-eu", service: "payment-service" },
    { allow: false, reason: "denied — no bound role" },
    "rbac"
  );
  const [e] = log.entries();
  assert.equal(e.event.kind, "access-decision");
  assert.equal(e.event.module, "rbac");
  assert.equal(e.event.principalId, "key:bob");
  assert.equal(e.event.allow, false);
  assert.equal(e.event.request.tool, "query_metrics");
  assert.match(e.event.reason, /no bound role/);
  assert.equal(verifyChain(log.entries()).ok, true);
});

test("auditDecision tolerates missing ctx/request/decision", async () => {
  const log = createAuditLog({ now: fixedClock() });
  await auditDecision(log, undefined, undefined, undefined, undefined);
  const [e] = log.entries();
  assert.equal(e.event.principalId, null);
  assert.equal(e.event.module, "unknown");
  assert.equal(e.event.allow, false);
  assert.equal(verifyChain(log.entries()).ok, true);
});

test("verifyChain rejects non-arrays and empty is trivially ok", () => {
  assert.equal(verifyChain(null).ok, false);
  assert.equal(verifyChain([]).ok, true);
});

// Regression: an event with absent (undefined) fields — exactly what the
// enterprise gate emits for a tool call with no `source` — must still
// verify AFTER a JSON persist→reload round-trip. canonical() must drop
// undefined keys the same way JSON.stringify does, or the tamper-evidence
// is silently broken in real use. (Found via a live gate test.)
test("canonical mirrors JSON for undefined keys (no-JSON values)", () => {
  assert.equal(canonical({ a: undefined, b: 1 }), canonical(JSON.parse(JSON.stringify({ a: undefined, b: 1 }))));
  assert.equal(canonical({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonical([1, undefined, 2]), "[1,null,2]"); // JSON.stringify → [1,null,2]
  assert.equal(canonical(undefined), "null");
  assert.equal(canonical({ f: () => 1, s: Symbol("x"), keep: "y" }), '{"keep":"y"}');
});

test("a persisted+reloaded chain with undefined fields re-verifies", async () => {
  const file = [];
  const log = createAuditLog({ now: fixedClock(), sink: (e) => file.push(JSON.stringify(e)) });
  // The exact shape enterprise-gate emits when a tool omits source/service:
  await log.record({ kind: "access-decision", request: { tool: "query_metrics", source: undefined, service: "pay" }, allow: true });
  await log.record({ kind: "access-decision", request: { tool: "list_services", source: undefined, service: undefined }, allow: false });
  assert.equal(log.verify().ok, true); // in-memory
  const reloaded = file.map((l) => JSON.parse(l)); // what a verifier on disk sees
  assert.deepEqual(verifyChain(reloaded), { ok: true });
});
