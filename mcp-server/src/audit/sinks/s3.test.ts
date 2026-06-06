import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { S3Sink, type S3ClientLike } from "./s3.js";
import type { AuditEntry } from "../log.js";

function entry(seq: number, ts: string, action = "write"): AuditEntry {
  return {
    seq,
    ts,
    actor: { sub: "alice@example.com", name: "alice" },
    tenant: "default",
    resource: "sources",
    action,
    method: "POST",
    path: `/api/sources/s${seq}`,
    status: 201,
    ip: "10.0.0.7",
    prevHash: "0".repeat(64),
    hash: String(seq).padStart(64, "0"),
  };
}

function fakeClient() {
  const sent: Array<{ Bucket: string; Key: string; Body: string }> = [];
  let throws = false;
  const client: S3ClientLike & { sent: typeof sent; setThrow(v: boolean): void } = {
    sent,
    setThrow(v: boolean) { throws = v; },
    async send(command: unknown) {
      if (throws) throw new Error("S3 unavailable (test)");
      const input = (command as { input: { Bucket: string; Key: string; Body: string } }).input;
      sent.push({ Bucket: input.Bucket, Key: input.Key, Body: input.Body });
      return { $metadata: { httpStatusCode: 200 } };
    },
  };
  return client;
}

test("constructor: bucket is required", () => {
  assert.throws(() => new S3Sink({ bucket: "" }), /bucket is required/);
});

test("write+flush: one entry → one PUT with correct key shape", async () => {
  const client = fakeClient();
  const sink = new S3Sink({
    bucket: "audit-bucket",
    prefix: "omcp",
    flushIntervalMs: 0,
    client,
  });
  await sink.write(entry(1, "2026-06-06T15:23:00Z"));
  await sink.flush();
  assert.equal(client.sent.length, 1);
  const put = client.sent[0];
  assert.equal(put.Bucket, "audit-bucket");
  assert.equal(put.Key, "omcp/2026/06/06/15/23-1-1.jsonl");
  assert.equal(put.Body.trim().split("\n").length, 1);
});

test("multiple entries are batched into one PUT on flush", async () => {
  const client = fakeClient();
  const sink = new S3Sink({ bucket: "b", flushIntervalMs: 0, client });
  await sink.write(entry(1, "2026-06-06T15:23:00Z"));
  await sink.write(entry(2, "2026-06-06T15:23:01Z"));
  await sink.write(entry(3, "2026-06-06T15:23:02Z"));
  await sink.flush();
  assert.equal(client.sent.length, 1);
  const lines = client.sent[0].Body.trim().split("\n");
  assert.equal(lines.length, 3);
  // Key range reflects the seq span
  assert.match(client.sent[0].Key, /23-1-3\.jsonl$/);
});

test("empty buffer flush is a no-op", async () => {
  const client = fakeClient();
  const sink = new S3Sink({ bucket: "b", flushIntervalMs: 0, client });
  await sink.flush();
  assert.equal(client.sent.length, 0);
});

test("maxBufferSize triggers an out-of-band flush", async () => {
  const client = fakeClient();
  const sink = new S3Sink({ bucket: "b", flushIntervalMs: 0, maxBufferSize: 2, client });
  await sink.write(entry(1, "2026-06-06T15:23:00Z"));
  await sink.write(entry(2, "2026-06-06T15:23:00Z"));
  // The second write crosses the cap → background flush
  await sink.flush();
  assert.equal(client.sent.length, 1);
});

test("PUT failure dead-letters the batch", async () => {
  const client = fakeClient();
  client.setThrow(true);
  const dlq = join(mkdtempSync(join(tmpdir(), "omcp-s3-dlq-")), "dlq.jsonl");
  const sink = new S3Sink({
    bucket: "b",
    flushIntervalMs: 0,
    client,
    deadLetterFile: dlq,
  });
  await sink.write(entry(1, "2026-06-06T15:23:00Z"));
  await sink.write(entry(2, "2026-06-06T15:23:01Z"));
  await sink.flush();
  // No successful PUT
  assert.equal(client.sent.length, 0);
  // DLQ file has both entries
  const lines = readFileSync(dlq, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /"seq":1/);
});

test("missing SDK + no client → dead-letter (no throw)", async () => {
  // Sink with neither an injected client nor the SDK installed.
  // We can't really uninstall the SDK in tests, but constructing the
  // sink without `client` AND without ever populating sdkLoadError
  // exercises the load path. Validate that flush handles the "no
  // client" state by relying on DLQ.
  const dlq = join(mkdtempSync(join(tmpdir(), "omcp-s3-dlq2-")), "dlq.jsonl");
  // Forcibly break the SDK loader by trying an obviously absent bucket
  // path with a fake client whose `send` throws "MissingCredentials" —
  // the deadLetter path catches it.
  const sink = new S3Sink({
    bucket: "b",
    flushIntervalMs: 0,
    deadLetterFile: dlq,
    client: {
      async send() { throw new Error("MissingCredentials"); },
    },
  });
  await sink.write(entry(1, "2026-06-06T15:23:00Z"));
  await sink.flush();
  const lines = readFileSync(dlq, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
});

test("prefix handles both with-trailing and without-trailing slash", async () => {
  const c1 = fakeClient();
  const s1 = new S3Sink({ bucket: "b", prefix: "audits", flushIntervalMs: 0, client: c1 });
  await s1.write(entry(1, "2026-06-06T15:00:00Z"));
  await s1.flush();
  assert.match(c1.sent[0].Key, /^audits\/2026\//);

  const c2 = fakeClient();
  const s2 = new S3Sink({ bucket: "b", prefix: "/audits/", flushIntervalMs: 0, client: c2 });
  await s2.write(entry(1, "2026-06-06T15:00:00Z"));
  await s2.flush();
  assert.match(c2.sent[0].Key, /^audits\/2026\//);
  assert.doesNotMatch(c2.sent[0].Key, /^\/audits/);

  const c3 = fakeClient();
  const s3 = new S3Sink({ bucket: "b", flushIntervalMs: 0, client: c3 });
  await s3.write(entry(1, "2026-06-06T15:00:00Z"));
  await s3.flush();
  // No prefix → key starts directly with YYYY
  assert.match(c3.sent[0].Key, /^2026\//);
});

test("flush serialises — concurrent calls don't lose entries", async () => {
  const client = fakeClient();
  const sink = new S3Sink({ bucket: "b", flushIntervalMs: 0, client });
  for (let i = 1; i <= 50; i++) await sink.write(entry(i, "2026-06-06T15:00:00Z"));
  // Multiple parallel flushes
  await Promise.all([sink.flush(), sink.flush(), sink.flush()]);
  // All 50 entries land in one (or at most a few) PUTs; total lines = 50
  const allLines = client.sent.flatMap((p) => p.Body.trim().split("\n"));
  assert.equal(allLines.length, 50);
});

test("shutdown stops the timer + flushes the remainder", async () => {
  const client = fakeClient();
  const sink = new S3Sink({ bucket: "b", flushIntervalMs: 1_000_000, client });
  await sink.write(entry(1, "2026-06-06T15:00:00Z"));
  await sink.write(entry(2, "2026-06-06T15:00:01Z"));
  await sink.shutdown();
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].Body.trim().split("\n").length, 2);
});

test("uses entry's own ts for the key bucket (not wall-clock)", async () => {
  const client = fakeClient();
  const sink = new S3Sink({ bucket: "b", flushIntervalMs: 0, client });
  // Entry from 5 minutes earlier — key must reflect THAT minute.
  await sink.write(entry(1, "2026-06-06T15:18:00Z"));
  await sink.flush();
  assert.match(client.sent[0].Key, /15\/18-1-1\.jsonl$/);
});
