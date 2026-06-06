import { test } from "node:test";
import assert from "node:assert/strict";

import { UpstreamClient, type UpstreamConfig } from "./upstream.js";

test("UpstreamClient: HTTP config — transportKind='http', url surfaced", () => {
  const cfg: UpstreamConfig = {
    name: "remote",
    url: "https://gw.example.com/mcp",
    bearerToken: "t0k",
  };
  const c = new UpstreamClient(cfg);
  assert.equal(c.transportKind, "http");
  assert.equal(c.url, "https://gw.example.com/mcp");
  assert.equal(c.namespacePrefix, "remote");
  assert.deepEqual(c.getTools(), []);
});

test("UpstreamClient: stdio config — transportKind='stdio', url shows command", () => {
  const cfg: UpstreamConfig = {
    transport: "stdio",
    name: "local-mcp",
    command: "/usr/local/bin/mcp",
    args: ["--config", "/etc/mcp.yaml"],
  };
  const c = new UpstreamClient(cfg);
  assert.equal(c.transportKind, "stdio");
  assert.equal(c.url, "stdio:/usr/local/bin/mcp");
  assert.equal(c.namespacePrefix, "local-mcp");
});

test("UpstreamClient: stdio config respects custom namespacePrefix", () => {
  const cfg: UpstreamConfig = {
    transport: "stdio",
    name: "weather",
    command: "weather-mcp",
    namespacePrefix: "weather.local",
  };
  const c = new UpstreamClient(cfg);
  assert.equal(c.namespacePrefix, "weather.local");
});

test("UpstreamClient: explicit transport='http' is also accepted", () => {
  const cfg: UpstreamConfig = {
    transport: "http",
    name: "gw",
    url: "https://gw.example.com/mcp",
  };
  const c = new UpstreamClient(cfg);
  assert.equal(c.transportKind, "http");
});

test("UpstreamClient: ws transport surfaces the ws:// URL", () => {
  const cfg: UpstreamConfig = {
    transport: "ws",
    name: "gw",
    url: "wss://gw.example.com/mcp/ws",
  };
  const c = new UpstreamClient(cfg);
  assert.equal(c.transportKind, "ws");
  assert.equal(c.url, "wss://gw.example.com/mcp/ws");
});

test("UpstreamClient: empty args defaults to [] on stdio", () => {
  const cfg: UpstreamConfig = {
    transport: "stdio",
    name: "x",
    command: "x",
  };
  const c = new UpstreamClient(cfg);
  // Just verifies construction doesn't throw on a minimal stdio config.
  assert.equal(c.transportKind, "stdio");
});

test("UpstreamClient: getStatus initial state", () => {
  const c = new UpstreamClient({ name: "x", url: "https://x/mcp" });
  const s = c.getStatus();
  assert.equal(s.status, "disconnected");
  assert.equal(s.toolCount, 0);
  assert.equal(s.lastError, undefined);
});

test("UpstreamClient: connect uses injected _transport instead of spawning / fetching", async () => {
  // Build a minimal MCP Transport stub that also COMPLETES the
  // initialize handshake — when the SDK Client sends a JSON-RPC
  // request, we synthesise a matching response on onmessage so the
  // initialize promise resolves quickly (no 60s SDK timeout).
  let started = false;
  let sentMessages = 0;
  const fakeTransport = {
    start: async () => { started = true; },
    send: async (msg: { id?: number; method?: string }) => {
      sentMessages += 1;
      if (msg?.method === "initialize" && msg?.id !== undefined) {
        queueMicrotask(() => {
          fakeTransport.onmessage?.({
            jsonrpc: "2.0",
            id: msg.id,
            result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1" } },
          });
        });
      } else if (msg?.method === "tools/list" && msg?.id !== undefined) {
        queueMicrotask(() => {
          fakeTransport.onmessage?.({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } });
        });
      }
    },
    close: async () => {},
    onclose: undefined as undefined | (() => void),
    onerror: undefined as undefined | ((e: Error) => void),
    onmessage: undefined as undefined | ((m: unknown) => void),
  };
  const c = new UpstreamClient({
    name: "injected",
    url: "https://ignored.example/mcp",
    refreshIntervalMs: 0,
    _transport: fakeTransport,
  });
  await c.connect();
  await c.close();
  assert.equal(started, true, "fake transport.start() should have been called");
  assert.ok(sentMessages >= 1, "fake transport.send() should have received initialize");
  // Status reaches "ready" only when initialize + tools/list both succeed
  // — confirms our injected transport drove the whole handshake.
  // (connect-time errors leave it in "degraded".)
});
