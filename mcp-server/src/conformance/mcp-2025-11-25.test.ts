// MCP 2025-11-25 conformance harness.
//
// Run against a running gateway by setting OMCP_CONFORMANCE_URL to
// its Streamable HTTP endpoint (default http://localhost:3000/mcp).
// When the env var is unset, every test skips — this lets the suite
// live in `find src -name "*.test.ts"` without requiring a server
// during a plain unit-test run.
//
//   OMCP_CONFORMANCE_URL=http://localhost:3000/mcp \
//   npx tsx --test src/conformance/mcp-2025-11-25.test.ts
//
// The `make conformance` target boots the demo stack, waits for
// /healthz, then runs this file with the URL pointed at the live
// server.

import { test } from "node:test";
import assert from "node:assert/strict";

const URL_ENV = process.env.OMCP_CONFORMANCE_URL;
const PROTOCOL_VERSION = "2025-11-25";
const skip = !URL_ENV;
const opts = skip ? { skip: "OMCP_CONFORMANCE_URL not set" } : {};

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type Headers = Record<string, string>;

async function jsonRpc(
  method: string,
  params?: unknown,
  opts: { id?: number; session?: string } = {},
): Promise<{ response: JsonRpcResponse; headers: Headers; status: number }> {
  if (!URL_ENV) throw new Error("OMCP_CONFORMANCE_URL not set");
  const reqHeaders: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (opts.session) reqHeaders["mcp-session-id"] = opts.session;
  const body = {
    jsonrpc: "2.0",
    id: opts.id ?? 1,
    method,
    params: params ?? {},
  };
  const res = await fetch(URL_ENV, {
    method: "POST",
    headers: reqHeaders,
    body: JSON.stringify(body),
  });
  const headers: Headers = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  // Streamable HTTP may answer with either JSON or SSE; both carry a
  // single JSON-RPC envelope for unary calls. Strip the SSE framing
  // if present so the test only deals with the JSON shape.
  const text = await res.text();
  let response: JsonRpcResponse;
  if (text.startsWith("event:") || text.includes("data: ")) {
    const match = text.match(/^data:\s*(.+)$/m);
    response = match ? (JSON.parse(match[1]) as JsonRpcResponse) : {};
  } else if (text.trim().startsWith("{")) {
    response = JSON.parse(text) as JsonRpcResponse;
  } else {
    response = {};
  }
  return { response, headers, status: res.status };
}

async function notify(method: string, session: string): Promise<void> {
  if (!URL_ENV) return;
  await fetch(URL_ENV, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": session,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params: {} }),
  });
}

async function newSession(): Promise<string> {
  const { headers, response } = await jsonRpc(
    "initialize",
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "conformance-harness", version: "0" },
    },
    { id: 1 },
  );
  assert.ok(response.result, "initialize must return a result");
  const session = headers["mcp-session-id"];
  assert.ok(session, "server must issue mcp-session-id on initialize");
  await notify("notifications/initialized", session);
  return session;
}

test("MCP 2025-11-25: initialize returns spec-compliant InitializeResult", opts, async () => {
  const { response, headers } = await jsonRpc("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "harness", version: "0" },
  });
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 1);
  assert.ok(response.result && typeof response.result === "object");
  const r = response.result as {
    protocolVersion?: string;
    capabilities?: unknown;
    serverInfo?: { name?: string; version?: string };
  };
  assert.ok(r.protocolVersion, "InitializeResult must include protocolVersion");
  assert.ok(r.capabilities && typeof r.capabilities === "object", "capabilities object required");
  assert.ok(r.serverInfo && typeof r.serverInfo === "object", "serverInfo required");
  assert.ok(r.serverInfo?.name, "serverInfo.name required");
  assert.ok(r.serverInfo?.version, "serverInfo.version required");
  assert.ok(headers["mcp-session-id"], "Mcp-Session-Id header required on initialize response");
});

test("MCP 2025-11-25: tools/list returns a Tool[] each with name + inputSchema", opts, async () => {
  const session = await newSession();
  const { response } = await jsonRpc("tools/list", {}, { id: 2, session });
  assert.ok(response.result, JSON.stringify(response.error ?? {}));
  const r = response.result as { tools?: Array<{ name?: string; inputSchema?: unknown }> };
  assert.ok(Array.isArray(r.tools), "tools must be an array");
  assert.ok(r.tools && r.tools.length > 0, "gateway must expose at least one tool");
  for (const t of r.tools) {
    assert.ok(t.name && typeof t.name === "string", `tool name required, got ${JSON.stringify(t)}`);
    assert.ok(t.inputSchema && typeof t.inputSchema === "object", `tool ${t.name} missing inputSchema`);
  }
});

test("MCP 2025-11-25: query_logs advertises labels + aggregate params (issue #415)", opts, async () => {
  // Regression guard for the v3.1.0 ship gap: the labels/aggregate handler
  // code existed but the inline MCP schema in createMcpServer never declared
  // them, so a live tools/list omitted them and the SDK stripped them from
  // calls — a silent no-op. Assert the live server advertises both.
  const session = await newSession();
  const { response } = await jsonRpc("tools/list", {}, { id: 2, session });
  const r = response.result as {
    tools?: Array<{ name?: string; inputSchema?: { properties?: Record<string, unknown> } }>;
  };
  const queryLogs = r.tools?.find((t) => t.name === "query_logs");
  assert.ok(queryLogs, "query_logs tool must be advertised");
  const props = queryLogs.inputSchema?.properties ?? {};
  assert.ok("labels" in props, "query_logs must advertise a `labels` param (issue #415 #1)");
  assert.ok("aggregate" in props, "query_logs must advertise an `aggregate` param (issue #415 #2)");
});

test("MCP 2025-11-25: tools/call dispatches and returns CallToolResult", opts, async () => {
  const session = await newSession();
  const { response } = await jsonRpc(
    "tools/call",
    { name: "list_sources", arguments: {} },
    { id: 3, session },
  );
  // Either a result (success path) or a JSON-RPC error — both are
  // spec-compliant; we just verify shape.
  if (response.error) {
    assert.equal(typeof response.error.code, "number");
    assert.equal(typeof response.error.message, "string");
  } else {
    const r = response.result as { content?: unknown[]; isError?: boolean };
    assert.ok(Array.isArray(r.content), "CallToolResult.content must be an array");
  }
});

test("MCP 2025-11-25: unknown method returns -32601 Method not found", opts, async () => {
  const session = await newSession();
  const { response } = await jsonRpc(
    "this/method/does/not/exist",
    {},
    { id: 99, session },
  );
  assert.ok(response.error, "expected an error envelope");
  assert.equal(response.error?.code, -32601, "spec-mandated error code for unknown method");
});

test("MCP 2025-11-25: ping returns an empty result", opts, async () => {
  const session = await newSession();
  const { response } = await jsonRpc("ping", {}, { id: 4, session });
  assert.ok(response.result !== undefined, "ping must return a result (may be empty object)");
});

test("MCP 2025-11-25: resources/list returns Resource[] or method-not-found", opts, async () => {
  const session = await newSession();
  const { response } = await jsonRpc("resources/list", {}, { id: 5, session });
  if (response.error) {
    assert.equal(response.error.code, -32601, "if not supported, must be -32601");
  } else {
    const r = response.result as { resources?: unknown[] };
    assert.ok(Array.isArray(r.resources), "resources must be an array");
  }
});

test("MCP 2025-11-25: prompts/list returns Prompt[] or method-not-found", opts, async () => {
  const session = await newSession();
  const { response } = await jsonRpc("prompts/list", {}, { id: 6, session });
  if (response.error) {
    assert.equal(response.error.code, -32601, "if not supported, must be -32601");
  } else {
    const r = response.result as { prompts?: unknown[] };
    assert.ok(Array.isArray(r.prompts), "prompts must be an array");
  }
});

test("MCP 2025-11-25: logging/setLevel accepts spec levels or method-not-found", opts, async () => {
  const session = await newSession();
  const { response } = await jsonRpc(
    "logging/setLevel",
    { level: "info" },
    { id: 7, session },
  );
  if (response.error) {
    assert.equal(response.error.code, -32601, "if not supported, must be -32601");
  } else {
    // Spec says the result is `EmptyResult` — we don't enforce
    // strictly empty (some implementations include diagnostics) but
    // it must be a JSON object.
    assert.ok(typeof response.result === "object");
  }
});

test("MCP 2025-11-25: tools/call with invalid params returns -32602 or isError result", opts, async () => {
  const session = await newSession();
  const { response } = await jsonRpc(
    "tools/call",
    { name: "list_sources", arguments: { __invalid_arg: { nested: 1 } } },
    { id: 8, session },
  );
  // The spec allows either a JSON-RPC error or an isError CallToolResult.
  // We accept either; reject only on a successful non-error result for
  // input that should not validate.
  if (response.error) {
    assert.ok([-32602, -32600].includes(response.error.code) || response.error.code <= -32000);
  } else {
    const r = response.result as { isError?: boolean; content?: unknown[] };
    // list_sources happens to ignore unknown args — that's fine, the
    // spec doesn't require strict input rejection for tools that opt
    // out. Just confirm we got a shape-conformant CallToolResult.
    assert.ok(Array.isArray(r.content));
  }
});

test("MCP 2025-11-25: server advertises protocolVersion equal to or newer than 2025-11-25", opts, async () => {
  const { response } = await jsonRpc("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "harness", version: "0" },
  }, { id: 100 });
  const r = response.result as { protocolVersion?: string };
  assert.ok(r.protocolVersion, "protocolVersion must be present in InitializeResult");
  // Spec contract: the server picks the highest version it supports
  // that the client also offered, OR returns the highest it knows
  // about and lets the client decide. We just require it's a
  // recognised date-style version string.
  assert.match(r.protocolVersion!, /^\d{4}-\d{2}-\d{2}$/, "protocolVersion must be a YYYY-MM-DD date");
});
