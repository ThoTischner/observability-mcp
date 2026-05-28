// End-to-end tests for the verify-audit CLI. Spawns the real script
// against synthetic JSONL files and asserts exit code + stdout shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "verify-audit.mjs");

function canonicalJson(v) {
  if (v === undefined) return "";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map((x) => canonicalJson(x ?? null)).join(",") + "]";
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}
function chainHash(e) { return createHash("sha256").update(canonicalJson(e)).digest("hex"); }
function entry(seq, prev, overrides = {}) {
  const base = {
    ts: `2026-05-28T00:00:${String(seq).padStart(2, "0")}Z`,
    seq,
    prevHash: prev,
    actor: { sub: "alice" },
    resource: "sources",
    action: "write",
    method: "POST",
    path: "/api/sources",
    status: 200,
    ...overrides,
  };
  return { ...base, hash: chainHash(base) };
}

async function writeChain(file, count = 3) {
  let prev = "0".repeat(64);
  const lines = [];
  for (let i = 1; i <= count; i++) {
    const e = entry(i, prev);
    lines.push(JSON.stringify(e));
    prev = e.hash;
  }
  await writeFile(file, lines.join("\n") + "\n", "utf8");
  return prev; // tip hash
}

function run(args) {
  return spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
}

test("verify-audit — exits 2 with usage on no args", () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage:/);
});

test("verify-audit — exits 0 on a clean chain, emits tipHash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omcp-verify-"));
  try {
    const file = join(dir, "audit.jsonl");
    const tip = await writeChain(file, 4);
    const r = run([file]);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.entries, 4);
    assert.equal(out.tipHash, tip);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify-audit — exits 0 on an empty file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omcp-verify-"));
  try {
    const file = join(dir, "audit.jsonl");
    await writeFile(file, "", "utf8");
    const r = run([file]);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.entries, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify-audit — exits 1 with brokenAt on tampered content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omcp-verify-"));
  try {
    const file = join(dir, "audit.jsonl");
    await writeChain(file, 3);
    // Hand-edit entry 2 to swap the actor without recomputing hash.
    const tampered = (await import("node:fs/promises")).readFile(file, "utf8");
    const raw = await tampered;
    const rewritten = raw.replace(/"sub":"alice"/, '"sub":"mallory"');
    await writeFile(file, rewritten, "utf8");
    const r = run([file]);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    // The tamper hits entry 1 (index 0) because the regex replaces the first match.
    assert.equal(out.brokenAt, 0);
    assert.match(out.reason, /hash mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify-audit — exits 1 with cannot-read on a missing file", () => {
  const r = run(["/nonexistent/audit-omcp-test.jsonl"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read/);
});

test("verify-audit — skips malformed JSONL lines, verifies the rest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omcp-verify-"));
  try {
    const file = join(dir, "audit.jsonl");
    const e1 = entry(1, "0".repeat(64));
    const e2 = entry(2, e1.hash);
    const content = [JSON.stringify(e1), "{this is not json", JSON.stringify(e2)].join("\n");
    await writeFile(file, content + "\n", "utf8");
    const r = run([file]);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.entries, 2);
    assert.match(r.stderr, /not valid JSON, skipping/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
