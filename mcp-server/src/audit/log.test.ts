import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog, verifyChain, chainHash, type AuditEntry } from "./log.js";

function sample(seq: number, prevHash: string): AuditEntry {
  const base = {
    ts: `2026-05-28T00:00:${String(seq).padStart(2, "0")}Z`,
    seq,
    prevHash,
    actor: { sub: "alice" },
    resource: "sources",
    action: "write",
    method: "POST",
    path: "/api/sources",
    status: 200,
  };
  const hash = chainHash(base);
  return { ...base, hash };
}

test("AuditLog in-memory — record + list", async () => {
  const log = new AuditLog();
  await log.record({
    actor: { sub: "alice", name: "Alice" },
    resource: "sources",
    action: "write",
    method: "POST",
    path: "/api/sources",
    status: 200,
  });
  await log.record({
    actor: { sub: "bob" },
    resource: "settings",
    action: "write",
    method: "PUT",
    path: "/api/settings",
    status: 200,
  });
  const entries = log.list();
  assert.equal(entries.length, 2);
  // Most recent first.
  assert.equal(entries[0].actor.sub, "bob");
  assert.equal(entries[1].actor.sub, "alice");
  // Chain is intact: prevHash of entry 2 equals hash of entry 1
  // (entries[1] is the FIRST chronologically here).
  assert.equal(entries[0].prevHash, entries[1].hash);
});

test("AuditLog — list filters by actor + action + window", async () => {
  const log = new AuditLog();
  await log.record({ actor: { sub: "alice" }, resource: "sources", action: "write", method: "POST", path: "/api/sources", status: 200 });
  await log.record({ actor: { sub: "bob" },   resource: "sources", action: "delete", method: "DELETE", path: "/api/sources/x", status: 200 });
  await log.record({ actor: { sub: "alice" }, resource: "settings", action: "write", method: "PUT", path: "/api/settings", status: 200 });

  assert.equal(log.list({ actor: "alice" }).length, 2);
  assert.equal(log.list({ action: "delete" }).length, 1);
  assert.equal(log.list({ actor: "bob", action: "delete" }).length, 1);
  // Empty window → nothing
  assert.equal(log.list({ from: "2099-01-01", to: "2099-12-31" }).length, 0);
});

test("AuditLog — in-memory ring honours cap", async () => {
  const log = new AuditLog({ inMemoryCap: 3 });
  for (let i = 0; i < 10; i++) {
    await log.record({ actor: { sub: `u${i}` }, resource: "sources", action: "write", method: "POST", path: "/api/sources", status: 200 });
  }
  const entries = log.list({ limit: 100 });
  assert.equal(entries.length, 3);
  // Only the three most recent should survive.
  assert.deepEqual(entries.map((e) => e.actor.sub), ["u9", "u8", "u7"]);
});

test("AuditLog — file mode persists and bootstraps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omcp-audit-"));
  const file = join(dir, "audit.jsonl");
  try {
    const log1 = new AuditLog({ file });
    await log1.bootstrap();
    await log1.record({ actor: { sub: "alice" }, resource: "sources", action: "write", method: "POST", path: "/api/sources", status: 200 });
    await log1.record({ actor: { sub: "alice" }, resource: "sources", action: "write", method: "POST", path: "/api/sources", status: 200 });
    // Allow the write queue to flush.
    await new Promise((r) => setTimeout(r, 30));

    const raw = await readFile(file, "utf8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 2);

    // Restart: bootstrap should pick up seq + lastHash.
    const log2 = new AuditLog({ file });
    await log2.bootstrap();
    assert.equal(log2.nextSeq, 3, "expected nextSeq to resume at 3 after replay");
    const next = await log2.record({ actor: { sub: "alice" }, resource: "sources", action: "write", method: "POST", path: "/api/sources", status: 200 });
    assert.equal(next.seq, 3);
    // prevHash chain continued from the replayed tip.
    const firstChain = JSON.parse(lines[0]) as AuditEntry;
    const secondChain = JSON.parse(lines[1]) as AuditEntry;
    assert.equal(secondChain.prevHash, firstChain.hash);
    assert.equal(next.prevHash, secondChain.hash);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifyChain — accepts a clean chain", () => {
  const e1 = sample(1, "0".repeat(64));
  const e2 = sample(2, e1.hash);
  const r = verifyChain([e1, e2]);
  assert.deepEqual(r, { ok: true });
});

test("verifyChain — rejects a flipped prevHash", () => {
  const e1 = sample(1, "0".repeat(64));
  const e2 = { ...sample(2, e1.hash), prevHash: "deadbeef".repeat(8) };
  const r = verifyChain([e1, e2]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.brokenAt, 1);
});

test("verifyChain — rejects an entry whose hash doesn't match its content", () => {
  const e1 = sample(1, "0".repeat(64));
  // Tamper with `actor` AFTER hashing.
  const e1Tampered = { ...e1, actor: { sub: "mallory" } };
  const r = verifyChain([e1Tampered]);
  assert.equal(r.ok, false);
});
