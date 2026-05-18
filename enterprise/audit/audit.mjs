// Append-only, tamper-evident audit log (FSL-1.1-Apache-2.0).
//
// Records access-control decisions (rbac / catalog) and tool
// invocations into a hash-chained sequence: every entry carries the
// hash of the previous entry, so any insertion, modification,
// reordering or truncation of the middle of the log is detectable by
// re-walking the chain. Uses only node:crypto — dependency-free.
//
// The log is sink-injected (default: in-memory) so it is pure and
// exhaustively testable; an operator passes a sink that appends a line
// to a file / ships it to a SIEM. The sink only ever APPENDS — there is
// no update or delete path by construction.

import { createHash } from "node:crypto";

const GENESIS = "0".repeat(64);

// Deterministic JSON: object keys sorted recursively, so the hash of a
// logically-equal record is stable regardless of insertion order.
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

function hashEntry(prevHash, body) {
  return createHash("sha256").update(prevHash + "\n" + canonical(body)).digest("hex");
}

/**
 * Create an append-only audit log.
 * @param opts.sink optional (entry) => void|Promise — receives each
 *   sealed entry exactly once, in order. Defaults to in-memory only.
 * @param opts.now  optional () => ISO string clock (injectable for tests)
 */
export function createAuditLog(opts = {}) {
  const sink = typeof opts.sink === "function" ? opts.sink : null;
  const now = typeof opts.now === "function" ? opts.now : () => new Date().toISOString();
  const entries = [];
  let lastHash = GENESIS;
  let seq = 0;

  async function record(event) {
    const body = {
      seq,
      ts: now(),
      prevHash: lastHash,
      event: event || {},
    };
    const hash = hashEntry(lastHash, body);
    const sealed = { ...body, hash };
    entries.push(sealed);
    lastHash = hash;
    seq += 1;
    if (sink) await sink(sealed);
    return sealed;
  }

  return {
    record,
    /** A defensive copy of the chain so far. */
    entries: () => entries.map((e) => ({ ...e })),
    head: () => lastHash,
    /** Verify the in-memory chain. */
    verify: () => verifyChain(entries),
  };
}

/**
 * Re-walk a chain and confirm every link. Detects modification,
 * insertion, reordering and truncation-in-the-middle.
 * @returns {{ok: boolean, brokenAt?: number, reason?: string}}
 */
export function verifyChain(records) {
  if (!Array.isArray(records)) return { ok: false, reason: "not an array" };
  let prev = GENESIS;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r || typeof r !== "object") return { ok: false, brokenAt: i, reason: "missing entry" };
    if (r.seq !== i) return { ok: false, brokenAt: i, reason: `seq ${r.seq} != position ${i}` };
    if (r.prevHash !== prev) return { ok: false, brokenAt: i, reason: "prevHash mismatch (reorder/insert/truncate)" };
    const { hash, ...body } = r;
    if (hashEntry(prev, body) !== hash) return { ok: false, brokenAt: i, reason: "hash mismatch (tampered)" };
    prev = hash;
  }
  return { ok: true };
}

/**
 * Convenience: record an access-control decision from rbac/catalog in a
 * consistent shape. `ctx` is duck-typed against the core RequestContext.
 */
export function auditDecision(log, ctx, request, decision, module) {
  const c = ctx || {};
  return log.record({
    kind: "access-decision",
    module: module || "unknown",
    principalId: c.principalId ?? null,
    auth: c.auth ?? null,
    correlationId: c.correlationId ?? null,
    request: {
      tool: (request && request.tool) ?? null,
      source: (request && request.source) ?? null,
      service: (request && request.service) ?? null,
    },
    allow: !!(decision && decision.allow),
    reason: (decision && decision.reason) ?? null,
  });
}
