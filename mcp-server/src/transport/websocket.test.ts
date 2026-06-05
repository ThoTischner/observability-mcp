import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { WebSocketServerTransport } from "./websocket.js";

// Minimal fake ws that satisfies the methods + events
// WebSocketServerTransport actually touches. Avoids pulling the real
// `ws` module into the unit-test runner (which is npm install + a TCP
// socket pair away).
class FakeWS extends EventEmitter {
  sent: string[] = [];
  closed?: { code: number; reason: string };
  pingCount = 0;
  send(text: string, cb: (err?: Error) => void): void {
    this.sent.push(text);
    cb();
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.emit("close");
  }
  ping(): void {
    this.pingCount++;
  }
}

function rpc(method: string, id: number): JSONRPCMessage {
  return { jsonrpc: "2.0", id, method } as unknown as JSONRPCMessage;
}

test("WebSocketServerTransport: parses one JSON message per text frame", async () => {
  const ws = new FakeWS();
  const t = new WebSocketServerTransport(ws as unknown as import("ws").WebSocket);
  const received: JSONRPCMessage[] = [];
  t.onmessage = (m) => received.push(m);
  await t.start();
  ws.emit("message", JSON.stringify(rpc("tools/list", 1)), false);
  ws.emit("message", JSON.stringify(rpc("tools/call", 2)), false);
  assert.equal(received.length, 2);
  assert.equal((received[0] as { method: string }).method, "tools/list");
  assert.equal((received[1] as { method: string }).method, "tools/call");
  await t.close();
});

test("WebSocketServerTransport: batched JSON arrays fan out", async () => {
  const ws = new FakeWS();
  const t = new WebSocketServerTransport(ws as unknown as import("ws").WebSocket);
  const received: JSONRPCMessage[] = [];
  t.onmessage = (m) => received.push(m);
  await t.start();
  ws.emit("message", JSON.stringify([rpc("a", 1), rpc("b", 2), rpc("c", 3)]), false);
  assert.equal(received.length, 3);
  await t.close();
});

test("WebSocketServerTransport: malformed JSON surfaces onerror, socket stays open", async () => {
  const ws = new FakeWS();
  const t = new WebSocketServerTransport(ws as unknown as import("ws").WebSocket);
  const errs: Error[] = [];
  t.onerror = (e) => errs.push(e);
  await t.start();
  ws.emit("message", "not-json{", false);
  assert.equal(errs.length, 1);
  assert.equal(ws.closed, undefined, "socket must NOT be closed on parse error");
  await t.close();
});

test("WebSocketServerTransport: binary frame rejected with onerror, socket stays open", async () => {
  const ws = new FakeWS();
  const t = new WebSocketServerTransport(ws as unknown as import("ws").WebSocket);
  const errs: Error[] = [];
  t.onerror = (e) => errs.push(e);
  await t.start();
  ws.emit("message", Buffer.from([0x01, 0x02]), true);
  assert.equal(errs.length, 1);
  assert.match(errs[0]?.message ?? "", /binary frame/i);
  assert.equal(ws.closed, undefined);
  await t.close();
});

test("WebSocketServerTransport: send() writes serialized message", async () => {
  const ws = new FakeWS();
  const t = new WebSocketServerTransport(ws as unknown as import("ws").WebSocket);
  await t.start();
  await t.send({ jsonrpc: "2.0", id: 1, result: { ok: true } } as unknown as JSONRPCMessage);
  assert.equal(ws.sent.length, 1);
  assert.match(ws.sent[0] ?? "", /"result":\{"ok":true\}/);
  await t.close();
});

test("WebSocketServerTransport: ws-close triggers onclose", async () => {
  const ws = new FakeWS();
  const t = new WebSocketServerTransport(ws as unknown as import("ws").WebSocket);
  let closed = false;
  t.onclose = () => {
    closed = true;
  };
  await t.start();
  ws.emit("close");
  assert.equal(closed, true);
  // Subsequent send must be a no-op (not throw).
  await t.send({ jsonrpc: "2.0", id: 99, result: {} } as unknown as JSONRPCMessage);
});

test("WebSocketServerTransport: heartbeat pings the socket on its interval", async () => {
  const ws = new FakeWS();
  const t = new WebSocketServerTransport(
    ws as unknown as import("ws").WebSocket,
    { pingIntervalMs: 20, pingTimeoutMs: 10_000 },
  );
  await t.start();
  await new Promise((r) => setTimeout(r, 65));
  assert.ok(ws.pingCount >= 2, `expected >=2 pings, got ${ws.pingCount}`);
  await t.close();
});

test("WebSocketServerTransport: stale connection (no pong) gets closed with 1001", async () => {
  const ws = new FakeWS();
  const t = new WebSocketServerTransport(
    ws as unknown as import("ws").WebSocket,
    { pingIntervalMs: 10, pingTimeoutMs: 25 },
  );
  await t.start();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(ws.closed?.code, 1001);
  assert.match(ws.closed?.reason ?? "", /heartbeat/);
});

test("WebSocketServerTransport: generates a sessionId by default", () => {
  const ws = new FakeWS();
  const t = new WebSocketServerTransport(ws as unknown as import("ws").WebSocket);
  assert.ok(t.sessionId, "sessionId must be set");
  assert.match(t.sessionId, /^[0-9a-f-]{36}$/);
});

test("WebSocketServerTransport: sessionId override is honored", () => {
  const ws = new FakeWS();
  const t = new WebSocketServerTransport(ws as unknown as import("ws").WebSocket, {
    sessionId: "test-session",
  });
  assert.equal(t.sessionId, "test-session");
});
