#!/usr/bin/env node
// Offline verifier for the management-plane audit log
// (OMCP_MGMT_AUDIT_FILE). Walks the JSONL file line-by-line, replays
// the SHA-256 hash chain in src/audit/log.ts:chainHash, and exits 0
// when every entry's prevHash + hash check out — non-zero otherwise.
//
// Standalone: no transpiled dist needed. Re-implements canonicalJson
// + chainHash + verifyChain identically to the server-side module so
// this script works straight from a source checkout (and from an air-
// gapped operator workstation).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stderr, stdout, argv, exit } from "node:process";

const GENESIS_HASH = "0".repeat(64);

function canonicalJson(v) {
  if (v === undefined) return "";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map((x) => canonicalJson(x ?? null)).join(",") + "]";
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}

function chainHash(entryWithoutHash) {
  return createHash("sha256").update(canonicalJson(entryWithoutHash)).digest("hex");
}

function verifyChain(entries) {
  let prev = GENESIS_HASH;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.prevHash !== prev) {
      return { ok: false, brokenAt: i, reason: `entry ${e.seq ?? "?"}: prevHash mismatch (expected ${prev}, got ${e.prevHash})` };
    }
    const { hash: _h, ...rest } = e;
    const expectedHash = chainHash(rest);
    if (e.hash !== expectedHash) {
      return { ok: false, brokenAt: i, reason: `entry ${e.seq ?? "?"}: hash mismatch (expected ${expectedHash}, got ${e.hash})` };
    }
    prev = e.hash;
  }
  return { ok: true };
}

function usage() {
  stderr.write(`Usage: node scripts/verify-audit.mjs [--quiet] <path-to-audit.jsonl>\n`);
  stderr.write(`\n`);
  stderr.write(`Exits 0 on a clean chain; non-zero with a brokenAt index + reason\n`);
  stderr.write(`on the first failure. Designed for offline / air-gapped operator\n`);
  stderr.write(`use — no node_modules required.\n`);
  stderr.write(`\n`);
  stderr.write(`Flags:\n`);
  stderr.write(`  --quiet, -q   silent on success; failure JSON still goes to stdout.\n`);
  stderr.write(`                Pairs cleanly with cron — no spam on a healthy chain.\n`);
}

function main() {
  const args = argv.slice(2);
  let quiet = false;
  const positional = [];
  for (const a of args) {
    if (a === "--quiet" || a === "-q") quiet = true;
    else if (a === "-h" || a === "--help") { usage(); exit(0); }
    else positional.push(a);
  }
  const path = positional[0];
  if (!path) { usage(); exit(2); }
  let raw;
  try { raw = readFileSync(path, "utf8"); }
  catch (e) { stderr.write(`cannot read ${path}: ${e.message}\n`); exit(1); }
  const entries = [];
  let lineNo = 0;
  for (const line of raw.split("\n")) {
    lineNo++;
    const t = line.trim();
    if (!t) continue;
    try { entries.push(JSON.parse(t)); }
    catch { stderr.write(`line ${lineNo}: not valid JSON, skipping\n`); }
  }
  if (entries.length === 0) {
    if (!quiet) stdout.write(JSON.stringify({ ok: true, entries: 0, note: "empty file" }) + "\n");
    return;
  }
  const result = verifyChain(entries);
  if (result.ok) {
    if (!quiet) stdout.write(JSON.stringify({ ok: true, entries: entries.length, tipHash: entries[entries.length - 1].hash }, null, 2) + "\n");
    exit(0);
  }
  // Failures are always loud — cron monitors key off this.
  stdout.write(JSON.stringify({ ok: false, entries: entries.length, ...result }, null, 2) + "\n");
  exit(1);
}

main();
