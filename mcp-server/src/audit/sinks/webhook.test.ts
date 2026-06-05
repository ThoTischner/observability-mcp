import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebhookSink } from "./webhook.js";
import type { AuditEntry } from "../log.js";

function sampleEntry(seq = 1): AuditEntry {
  return {
    ts: "2026-06-05T20:00:00.000Z",
    seq,
    actor: { sub: "alice", name: "alice" },
    tenant: "default",
    resource: "sources",
    action: "write",
    method: "POST",
    path: "/api/sources",
    status: 200,
    prevHash: "0".repeat(64),
    hash: "ff".repeat(32),
  };
}

function tmpDLQ(): string {
  return join(mkdtempSync(join(tmpdir(), "webhook-dlq-")), "dlq.jsonl");
}

function fakeFetchSequence(
  statuses: Array<{ ok: boolean; status?: number; text?: string }>,
): { fetchImpl: typeof fetch; calls: { count: number } } {
  let i = 0;
  const calls = { count: 0 };
  const fetchImpl = (async () => {
    calls.count++;
    const next = statuses[Math.min(i, statuses.length - 1)];
    i++;
    return {
      ok: next.ok,
      status: next.status ?? (next.ok ? 200 : 500),
      statusText: next.ok ? "OK" : "Server Error",
      text: async () => next.text ?? "",
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("WebhookSink: happy path POSTs once and flushes cleanly", async () => {
  const { fetchImpl, calls } = fakeFetchSequence([{ ok: true }]);
  const sink = new WebhookSink({
    url: "https://example.com/audit",
    fetchImpl,
    sleepImpl: async () => undefined,
  });
  await sink.write(sampleEntry());
  await sink.flush();
  assert.equal(calls.count, 1);
});

test("WebhookSink: retries with backoff on 500, succeeds on attempt 3", async () => {
  const { fetchImpl, calls } = fakeFetchSequence([
    { ok: false, status: 500 },
    { ok: false, status: 503 },
    { ok: true },
  ]);
  let sleeps = 0;
  const sink = new WebhookSink({
    url: "https://example.com/audit",
    fetchImpl,
    sleepImpl: async () => {
      sleeps++;
    },
    initialBackoffMs: 10,
    maxBackoffMs: 100,
    maxAttempts: 5,
  });
  await sink.write(sampleEntry());
  await sink.flush();
  assert.equal(calls.count, 3);
  assert.equal(sleeps, 2, "slept once between each failed attempt and the next");
});

test("WebhookSink: exhausts retries and writes to DLQ", async () => {
  const { fetchImpl, calls } = fakeFetchSequence([{ ok: false, status: 500 }]);
  const dlq = tmpDLQ();
  const sink = new WebhookSink({
    url: "https://example.com/audit",
    fetchImpl,
    sleepImpl: async () => undefined,
    initialBackoffMs: 1,
    maxAttempts: 3,
    deadLetterFile: dlq,
  });
  await sink.write(sampleEntry(42));
  await sink.flush();
  assert.equal(calls.count, 3, "tried maxAttempts times");
  assert.ok(existsSync(dlq), "DLQ file written");
  const written = readFileSync(dlq, "utf8");
  assert.match(written, /"seq":42/);
});

test("WebhookSink: write() does not throw even when underlying request fails", async () => {
  const fetchImpl = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const sink = new WebhookSink({
    url: "https://example.com/audit",
    fetchImpl,
    sleepImpl: async () => undefined,
    maxAttempts: 2,
    initialBackoffMs: 1,
  });
  // The contract: write() returns successfully (does NOT throw) even
  // when delivery fails — the failure is logged and DLQ-handled.
  await assert.doesNotReject(async () => {
    await sink.write(sampleEntry());
    await sink.flush();
  });
});

test("WebhookSink: bearer token forwarded as Authorization header", async () => {
  let seenAuth: string | undefined;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    seenAuth = headers["authorization"];
    return { ok: true, status: 200, statusText: "OK", text: async () => "" } as Response;
  }) as unknown as typeof fetch;
  const sink = new WebhookSink({
    url: "https://example.com/audit",
    token: "secret-abc",
    fetchImpl,
    sleepImpl: async () => undefined,
  });
  await sink.write(sampleEntry());
  await sink.flush();
  assert.equal(seenAuth, "Bearer secret-abc");
});

test("WebhookSink: write order is preserved across retries (serialized queue)", async () => {
  const seen: number[] = [];
  let nextOk = false;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    seen.push(body.seq);
    const wasOk = nextOk;
    nextOk = !wasOk; // alternate: first fails, second ok, etc.
    return {
      ok: wasOk,
      status: wasOk ? 200 : 500,
      statusText: "x",
      text: async () => "",
    } as Response;
  }) as unknown as typeof fetch;
  const sink = new WebhookSink({
    url: "https://example.com/audit",
    fetchImpl,
    sleepImpl: async () => undefined,
    initialBackoffMs: 1,
    maxAttempts: 4,
  });
  // Fire two writes concurrently; they must be delivered in order
  // because the internal queue serializes them.
  const p1 = sink.write(sampleEntry(1));
  const p2 = sink.write(sampleEntry(2));
  await Promise.all([p1, p2]);
  await sink.flush();
  // First entry's POSTs should all precede the second entry's POSTs.
  const firstIdx = seen.indexOf(1);
  const secondIdx = seen.indexOf(2);
  assert.ok(firstIdx >= 0 && secondIdx > firstIdx, `order broken: ${seen.join(",")}`);
});

test("WebhookSink: throws on missing url", () => {
  assert.throws(() => new WebhookSink({ url: "" }), /url is required/);
});
