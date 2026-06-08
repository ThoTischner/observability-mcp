import { test } from "node:test";
import assert from "node:assert/strict";

import { AnomalyHistory, fromEnv, type AnomalyRecord } from "./history.js";

function entry(overrides: Partial<AnomalyRecord> = {}): AnomalyRecord {
  return {
    ts: "2026-06-06T00:00:00.000Z",
    service: "payment",
    tenant: "default",
    score: 0.87,
    method: "mad",
    severity: "warn",
    ...overrides,
  };
}

function captureFetch(captureBody?: { body: unknown; headers: Record<string, string> }): typeof fetch {
  const f = (async (_url: string, init: RequestInit) => {
    if (captureBody) {
      captureBody.body = JSON.parse(init.body as string);
      captureBody.headers = init.headers as Record<string, string>;
    }
    return { ok: true, status: 200, statusText: "OK", text: async () => "" } as Response;
  }) as unknown as typeof fetch;
  return f;
}

test("fromEnv: missing URL → disabled config", () => {
  assert.equal(fromEnv({}).url, undefined);
});

test("fromEnv: parses URL + headers + token", () => {
  const cfg = fromEnv({
    OMCP_ANOMALY_HISTORY_REMOTE_WRITE: "https://tsdb/api/v1/write",
    OMCP_ANOMALY_HISTORY_HEADERS: "x-scope=tenant-a,x-extra=foo=bar",
    OMCP_ANOMALY_HISTORY_TOKEN: "secret-token",
  });
  assert.equal(cfg.url, "https://tsdb/api/v1/write");
  assert.deepEqual(cfg.headers, { "x-scope": "tenant-a", "x-extra": "foo=bar" });
  assert.equal(cfg.bearerToken, "secret-token");
});

test("isEnabled: false without url, true with url", () => {
  assert.equal(new AnomalyHistory({}).isEnabled(), false);
  assert.equal(new AnomalyHistory({ url: "https://x" }).isEnabled(), true);
});

test("record: disabled instance silently drops, buffer stays empty", async () => {
  const h = new AnomalyHistory({});
  await h.record(entry());
  assert.equal(h.bufferSize(), 0);
});

test("record + flush: posts the buffer as a remote-write-shaped JSON", async () => {
  const captured = {} as { body: unknown; headers: Record<string, string> };
  const h = new AnomalyHistory({
    url: "https://tsdb/api/v1/write",
    fetchImpl: captureFetch(captured),
  });
  await h.record(entry({ score: 0.9 }));
  await h.record(entry({ service: "orders", score: 0.42 }));
  await h.flush();
  const body = captured.body as { timeseries: Array<{ labels: Record<string, string>; samples: Array<{ value: number; timestamp: number }> }> };
  assert.equal(body.timeseries.length, 2);
  assert.equal(body.timeseries[0].labels.__name__, "omcp_anomaly_score");
  assert.equal(body.timeseries[0].labels.service, "payment");
  assert.equal(body.timeseries[0].samples[0].value, 0.9);
  assert.equal(body.timeseries[1].labels.service, "orders");
});

test("flush: bearer token forwarded as Authorization header", async () => {
  const captured = {} as { body: unknown; headers: Record<string, string> };
  const h = new AnomalyHistory({
    url: "https://tsdb/api/v1/write",
    bearerToken: "tok-abc",
    fetchImpl: captureFetch(captured),
  });
  await h.record(entry());
  await h.flush();
  assert.equal(captured.headers["authorization"], "Bearer tok-abc");
});

// --- Q21: in-process ring (Health-tab sparkline) ----------------------

const NOW = Date.parse("2026-06-06T12:00:00.000Z");
function at(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

test("ring captures records even when remote-write is disabled", async () => {
  const h = new AnomalyHistory({ now: () => NOW });
  assert.equal(h.isEnabled(), false);
  await h.record(entry({ ts: at(0), score: 0.5 }));
  const recent = h.recent();
  assert.equal(recent.length, 1);
  assert.equal(recent[0].score, 0.5);
  // ...but the remote-write buffer stays empty when disabled.
  assert.equal(h.bufferSize(), 0);
});

test("recent: drops records outside the retention window", async () => {
  const h = new AnomalyHistory({ now: () => NOW, retentionMs: 60 * 60 * 1000 });
  await h.record(entry({ ts: at(30 * 60 * 1000) })); // 30m ago — kept
  await h.record(entry({ ts: at(90 * 60 * 1000) })); // 90m ago — evicted on next push/prune
  const recent = h.recent();
  assert.equal(recent.length, 1);
  assert.equal(recent[0].ts, at(30 * 60 * 1000));
});

test("recent: oldest-first and filterable by service + tenant", async () => {
  const h = new AnomalyHistory({ now: () => NOW });
  await h.record(entry({ ts: at(3000), service: "payment", tenant: "a", score: 0.1 }));
  await h.record(entry({ ts: at(1000), service: "payment", tenant: "a", score: 0.3 }));
  await h.record(entry({ ts: at(2000), service: "orders", tenant: "a", score: 0.2 }));
  await h.record(entry({ ts: at(500), service: "payment", tenant: "b", score: 0.9 }));

  const pay = h.recent({ service: "payment", tenant: "a" });
  assert.deepEqual(pay.map((r) => r.score), [0.1, 0.3], "oldest-first, service+tenant filtered");

  const tenantA = h.recentServices("a").sort();
  assert.deepEqual(tenantA, ["orders", "payment"]);
  assert.deepEqual(h.recentServices("b"), ["payment"]);
});

test("ring honours the hard cap (ringMax)", async () => {
  const h = new AnomalyHistory({ now: () => NOW, ringMax: 3 });
  for (let i = 0; i < 10; i++) await h.record(entry({ ts: at(10_000 - i), score: i / 10 }));
  const recent = h.recent();
  assert.equal(recent.length, 3, "ring capped at ringMax");
});

test("windowMs surfaces the retention window", () => {
  assert.equal(new AnomalyHistory({ retentionMs: 1234 }).windowMs, 1234);
  assert.equal(new AnomalyHistory({}).windowMs, 60 * 60 * 1000);
});

test("flush: clears the buffer on success", async () => {
  const h = new AnomalyHistory({
    url: "https://tsdb/api/v1/write",
    fetchImpl: captureFetch(),
  });
  await h.record(entry());
  await h.record(entry());
  assert.equal(h.bufferSize(), 2);
  await h.flush();
  assert.equal(h.bufferSize(), 0);
});

test("flush: HTTP error logs + drops buffer (does NOT retry)", async () => {
  const f = (async () => ({
    ok: false,
    status: 503,
    statusText: "Service Unavailable",
    text: async () => "tsdb overloaded",
  } as Response)) as unknown as typeof fetch;
  const h = new AnomalyHistory({
    url: "https://tsdb/api/v1/write",
    fetchImpl: f,
  });
  await h.record(entry());
  await h.flush();
  // Best-effort policy: buffer cleared even on error.
  assert.equal(h.bufferSize(), 0);
});

test("flush: empty buffer is a no-op (no fetch call)", async () => {
  let called = 0;
  const f = (async () => {
    called++;
    return { ok: true, status: 200, statusText: "OK", text: async () => "" } as Response;
  }) as unknown as typeof fetch;
  const h = new AnomalyHistory({
    url: "https://tsdb/api/v1/write",
    fetchImpl: f,
  });
  await h.flush();
  assert.equal(called, 0);
});

test("record: synchronous auto-flush triggers when buffer crosses maxBufferSize", async () => {
  let calls = 0;
  const f = (async () => {
    calls++;
    return { ok: true, status: 200, statusText: "OK", text: async () => "" } as Response;
  }) as unknown as typeof fetch;
  const h = new AnomalyHistory({
    url: "https://tsdb/api/v1/write",
    fetchImpl: f,
    maxBufferSize: 3,
  });
  await h.record(entry());
  await h.record(entry());
  assert.equal(calls, 0);
  await h.record(entry()); // crosses threshold → auto-flush
  assert.equal(calls, 1);
  assert.equal(h.bufferSize(), 0);
});

test("formatBatch: omits empty optional signal label", async () => {
  const h = new AnomalyHistory({ url: "https://x" });
  const out = h.formatBatch([entry({ signal: "" })]) as { timeseries: Array<{ labels: Record<string, string> }> };
  assert.equal("signal" in out.timeseries[0].labels, false);
});

test("formatBatch: includes signal label when set", () => {
  const h = new AnomalyHistory({ url: "https://x" });
  const out = h.formatBatch([entry({ signal: "request_latency" })]) as { timeseries: Array<{ labels: Record<string, string> }> };
  assert.equal(out.timeseries[0].labels.signal, "request_latency");
});
