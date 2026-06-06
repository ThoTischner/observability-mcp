import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PostmortemStore } from "./store.js";
import type { PostmortemReport } from "./synthesizer.js";

function tmpStore(): string {
  return join(mkdtempSync(join(tmpdir(), "pmstore-")), "postmortems.jsonl");
}

function fakeReport(service = "payment"): PostmortemReport {
  return {
    service,
    window: "1h",
    fromIso: "2026-06-06T00:00:00.000Z",
    toIso: "2026-06-06T01:00:00.000Z",
    synopsis: "test",
    markdown: "# Test",
    sections: {
      timeline: [],
      blastRadius: { nodes: [], edgeCount: 0 },
      topTraces: [],
      contributingSignals: [],
      followUps: [],
      logHighlights: [],
    },
  };
}

test("PostmortemStore: load() on missing file → empty list", async () => {
  const s = new PostmortemStore(tmpStore());
  await s.load();
  assert.deepEqual(s.list(), []);
});

test("PostmortemStore: append issues UUID + ISO ts, persists JSONL", async () => {
  const path = tmpStore();
  const s = new PostmortemStore(path);
  await s.load();
  const stored = await s.append({ report: fakeReport(), createdBy: "alice", tenant: "default" });
  assert.match(stored.id, /^[0-9a-f-]{36}$/);
  assert.match(stored.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(stored.report.service, "payment");
  // disk format is one JSON per line
  const raw = readFileSync(path, "utf8");
  assert.equal(raw.split("\n").filter((l) => l).length, 1);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("PostmortemStore: list() returns newest-first", async () => {
  const s = new PostmortemStore(tmpStore());
  await s.load();
  await s.append({ report: fakeReport("a"), createdBy: "u", tenant: "t" });
  await new Promise((r) => setTimeout(r, 5));
  await s.append({ report: fakeReport("b"), createdBy: "u", tenant: "t" });
  const out = s.list();
  assert.equal(out[0].report.service, "b");
  assert.equal(out[1].report.service, "a");
});

test("PostmortemStore: list(tenant) scopes correctly", async () => {
  const s = new PostmortemStore(tmpStore());
  await s.load();
  await s.append({ report: fakeReport("a"), createdBy: "u", tenant: "alpha" });
  await s.append({ report: fakeReport("b"), createdBy: "u", tenant: "beta" });
  assert.equal(s.list("alpha").length, 1);
  assert.equal(s.list("alpha")[0].report.service, "a");
});

test("PostmortemStore: get() by id, tenant-scoped", async () => {
  const s = new PostmortemStore(tmpStore());
  await s.load();
  const e = await s.append({ report: fakeReport(), createdBy: "u", tenant: "alpha" });
  assert.equal(s.get(e.id)?.id, e.id);
  assert.equal(s.get(e.id, "alpha")?.id, e.id);
  // wrong tenant → undefined
  assert.equal(s.get(e.id, "beta"), undefined);
  assert.equal(s.get("nope"), undefined);
});

test("PostmortemStore: delete() rewrites file + scoped by tenant", async () => {
  const path = tmpStore();
  const s = new PostmortemStore(path);
  await s.load();
  const e1 = await s.append({ report: fakeReport("a"), createdBy: "u", tenant: "alpha" });
  await s.append({ report: fakeReport("b"), createdBy: "u", tenant: "beta" });
  // wrong tenant → no-op
  assert.equal(await s.delete(e1.id, "beta"), false);
  assert.equal(s.list().length, 2);
  // correct tenant → removed
  assert.equal(await s.delete(e1.id, "alpha"), true);
  assert.equal(s.list().length, 1);
  // disk reflects the rewrite
  const raw = readFileSync(path, "utf8");
  assert.equal(raw.split("\n").filter((l) => l).length, 1);
});

test("PostmortemStore: delete() missing id → false", async () => {
  const s = new PostmortemStore(tmpStore());
  await s.load();
  assert.equal(await s.delete("nope"), false);
});

test("PostmortemStore: round-trip through disk (load after append sees entries)", async () => {
  const path = tmpStore();
  const a = new PostmortemStore(path);
  await a.load();
  await a.append({ report: fakeReport("a"), createdBy: "u", tenant: "default" });
  await a.append({ report: fakeReport("b"), createdBy: "u", tenant: "default" });
  const b = new PostmortemStore(path);
  await b.load();
  assert.equal(b.list().length, 2);
});

test("PostmortemStore: load skips corrupt lines", async () => {
  const path = tmpStore();
  // Hand-write a file with one good + one garbage line
  const a = new PostmortemStore(path);
  await a.load();
  await a.append({ report: fakeReport(), createdBy: "u", tenant: "default" });
  const fs = await import("node:fs/promises");
  await fs.appendFile(path, "{not valid json\n");
  const b = new PostmortemStore(path);
  await b.load();
  // Good entry survived; corrupt line ignored.
  assert.equal(b.list().length, 1);
  assert.ok(existsSync(path));
});
