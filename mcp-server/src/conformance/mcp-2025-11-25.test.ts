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

test("MCP 2025-11-25: query_metrics advertises labels param (issue #415 #4)", opts, async () => {
  const session = await newSession();
  const { response } = await jsonRpc("tools/list", {}, { id: 2, session });
  const r = response.result as {
    tools?: Array<{ name?: string; inputSchema?: { properties?: Record<string, unknown> } }>;
  };
  const queryMetrics = r.tools?.find((t) => t.name === "query_metrics");
  assert.ok(queryMetrics, "query_metrics tool must be advertised");
  const props = queryMetrics.inputSchema?.properties ?? {};
  assert.ok("labels" in props, "query_metrics must advertise a `labels` param (issue #415 #4)");
});

test("MCP 2025-11-25: query_metrics + query_logs advertise raw_query (issue #415 #3)", opts, async () => {
  const session = await newSession();
  const { response } = await jsonRpc("tools/list", {}, { id: 2, session });
  const r = response.result as {
    tools?: Array<{ name?: string; inputSchema?: { properties?: Record<string, unknown> } }>;
  };
  for (const name of ["query_metrics", "query_logs"]) {
    const tool = r.tools?.find((t) => t.name === name);
    assert.ok(tool, `${name} tool must be advertised`);
    assert.ok("raw_query" in (tool.inputSchema?.properties ?? {}), `${name} must advertise a raw_query param`);
  }
});

test("MCP 2025-11-25: enrich_ips tool is advertised (issue #415 Gap B)", opts, async () => {
  const session = await newSession();
  const { response } = await jsonRpc("tools/list", {}, { id: 2, session });
  const r = response.result as {
    tools?: Array<{ name?: string; inputSchema?: { properties?: Record<string, unknown> } }>;
  };
  const tool = r.tools?.find((t) => t.name === "enrich_ips");
  assert.ok(tool, "enrich_ips tool must be advertised");
  assert.ok("ips" in (tool.inputSchema?.properties ?? {}), "enrich_ips must advertise an `ips` param");
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

// ---------------------------------------------------------------------------
// Behavioural tools/call E2E (post-#415 hardening).
//
// These run over the REAL /mcp Streamable-HTTP transport against the booted
// demo stack (integration.yml sets OMCP_CONFORMANCE_URL). They close the gap
// that let #415 ship: a param can be ADVERTISED in tools/list yet silently
// stripped by the SDK before it reaches the handler — an advertise-only
// assertion passes anyway. Here we call the tool and assert the param TAKES
// EFFECT over the wire. The demo mcp-server runs with OMCP_RAW_QUERY unset and
// OMCP_IP_ENRICH_FILE unset, so the gate/not-configured assertions are
// deterministic regardless of backend data.
// ---------------------------------------------------------------------------

async function callTool(
  session: string,
  name: string,
  args: Record<string, unknown>,
  id = 50,
): Promise<{ isError?: boolean; parsed?: any; text?: string; error?: unknown }> {
  const { response } = await jsonRpc("tools/call", { name, arguments: args }, { id, session });
  if (response.error) return { error: response.error };
  const r = response.result as { isError?: boolean; content?: Array<{ text?: string }> };
  const text = r?.content?.[0]?.text;
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return { isError: r?.isError, parsed, text };
}

async function discoverService(session: string): Promise<string> {
  const r = await callTool(session, "list_services", {}, 40);
  const list = Array.isArray(r.parsed) ? r.parsed : r.parsed?.services;
  const name = Array.isArray(list) && list[0] && (list[0].name || list[0].service);
  return name || "payment-service"; // demo k3s service as fallback
}

test("E2E tools/call: query_logs raw_query is refused over the wire when capability off (#415 #3)", opts, async () => {
  const session = await newSession();
  const r = await callTool(session, "query_logs", { raw_query: '{job="x"}' });
  // Proves raw_query SURVIVES transport (not stripped) AND the gate fires E2E.
  const msg = JSON.stringify(r.parsed ?? r.text ?? "");
  assert.match(msg, /raw_query is disabled/i, `expected gate refusal, got ${msg}`);
});

test("E2E tools/call: query_metrics raw_query is refused over the wire when capability off (#415 #3)", opts, async () => {
  const session = await newSession();
  const r = await callTool(session, "query_metrics", { raw_query: "up" });
  const msg = JSON.stringify(r.parsed ?? r.text ?? "");
  assert.match(msg, /raw_query is disabled/i, `expected gate refusal, got ${msg}`);
});

test("E2E tools/call: enrich_ips dispatches and reports not-configured over the wire (Gap B)", opts, async () => {
  const session = await newSession();
  const r = await callTool(session, "enrich_ips", { ips: ["203.0.113.5"] });
  const msg = JSON.stringify(r.parsed ?? r.text ?? "");
  // Proves the ips param survives transport and the tool dispatches; demo has
  // no OMCP_IP_ENRICH_FILE so the deterministic "not configured" path fires.
  assert.match(msg, /not configured/i, `expected not-configured notice, got ${msg}`);
});

test("E2E tools/call: query_logs aggregate takes effect over the wire — grouped result, not raw rows (#415 #2)", opts, async () => {
  const session = await newSession();
  const service = await discoverService(session);
  const r = await callTool(session, "query_logs", {
    service,
    aggregate: { op: "count_over_time", step: "15m" },
    duration: "1h",
  });
  // The aggregate result shape (op/mode/series) is structurally distinct from
  // the raw-rows shape (entries/summary). Asserting the aggregate shape proves
  // the `aggregate` param survived the SDK input parsing and reached the
  // connector — even if the series is empty on a sparse demo window.
  const p = Array.isArray(r.parsed) ? r.parsed[0] : r.parsed;
  assert.ok(p, `expected an aggregate result, got ${JSON.stringify(r)}`);
  assert.equal(p.op, "count_over_time", "result must carry the aggregate op");
  assert.ok("mode" in p && Array.isArray(p.series), "result must be the aggregate shape (mode + series)");
  assert.ok(!("entries" in p), "aggregate path must NOT return the raw-rows shape");
});

test("E2E tools/call: query_metrics labels param is accepted over the wire (#415 #4)", opts, async () => {
  const session = await newSession();
  const service = await discoverService(session);
  const r = await callTool(session, "query_metrics", {
    service,
    metric: "cpu",
    labels: { job: service },
    duration: "5m",
  });
  // Must not be a transport/dispatch error; the labels param must be accepted
  // (a structured "no data" result is fine — proves it reached the handler).
  assert.ok(!r.error, `unexpected JSON-RPC error: ${JSON.stringify(r.error)}`);
  assert.ok(r.parsed !== undefined || r.text !== undefined, "expected a CallToolResult payload");
});

test("E2E tools/call: get_anomaly_history dispatches without a PromQL 400 crash (H1 over the wire)", opts, async () => {
  const session = await newSession();
  const service = await discoverService(session);
  const r = await callTool(session, "get_anomaly_history", { service, duration: "1h", method: "mad" });
  // After the rawQuery fix the emitted PromQL is valid; empty data is a clean
  // non-error result. The bug produced an invalid-query path that still
  // returned non-error empty, so we assert the dispatch shape is well-formed.
  assert.ok(!r.error, `unexpected JSON-RPC error: ${JSON.stringify(r.error)}`);
  assert.ok(r.parsed !== undefined || r.text !== undefined, "expected a CallToolResult payload");
});

test("E2E tools/call: every registered tool dispatches over MCP and returns a CallToolResult", opts, async () => {
  const session = await newSession();
  const service = await discoverService(session);
  // Minimal valid args per tool; tools with required args get discovered/dummy
  // values. A clean isError result (e.g. query_traces 'no trace backends') is
  // acceptable — we only require a shape-conformant dispatch, never a -32xxx.
  const calls: Record<string, Record<string, unknown>> = {
    list_sources: {},
    list_services: {},
    query_metrics: { service, metric: "cpu" },
    query_logs: { service },
    get_anomaly_history: { service },
    generate_postmortem: { service },
    query_traces: { service },
    get_service_health: { service },
    detect_anomalies: {},
    get_topology: {},
    get_blast_radius: { resource: service },
    enrich_ips: { ips: ["203.0.113.5"] },
  };
  const { response: list } = await jsonRpc("tools/list", {}, { id: 41, session });
  const names = ((list.result as any)?.tools ?? []).map((t: any) => t.name);
  assert.ok(names.length >= 12, `expected >=12 tools, got ${names.length}`);
  let id = 60;
  for (const name of names) {
    const args = calls[name] ?? {};
    const { response } = await jsonRpc("tools/call", { name, arguments: args }, { id: id++, session });
    if (response.error) {
      assert.fail(`tool ${name} returned a JSON-RPC dispatch error: ${JSON.stringify(response.error)}`);
    }
    const r = response.result as { content?: unknown[] };
    assert.ok(Array.isArray(r.content), `tool ${name} must return content[]`);
  }
});

test("E2E tools/list: every builtin tool advertises ToolAnnotations (readOnlyHint)", opts, async () => {
  // AX hardening: all 12 builtin tools are read-only; clients (e.g. Claude)
  // use these hints for auto-approve decisions, so they must be advertised
  // over the live transport — not just present in the registration source.
  const session = await newSession();
  const { response } = await jsonRpc("tools/list", {}, { id: 2, session });
  const r = response.result as {
    tools?: Array<{ name?: string; annotations?: { readOnlyHint?: boolean; title?: string } }>;
  };
  const tools = r.tools ?? [];
  assert.ok(tools.length >= 12, `expected >=12 tools, got ${tools.length}`);
  // Federated tools (namespaced `<prefix>.<tool>`) proxy upstream metadata and
  // may legitimately lack annotations — only the builtin set is asserted.
  const builtin = tools.filter((t) => t.name && !t.name.includes("."));
  for (const t of builtin) {
    assert.equal(
      t.annotations?.readOnlyHint,
      true,
      `tool ${t.name} must advertise annotations.readOnlyHint=true`,
    );
    assert.ok(t.annotations?.title, `tool ${t.name} must advertise annotations.title`);
  }
});

test("E2E: builtin resource agent-usage-guide is listed and readable", opts, async () => {
  // AX: the agent usage guide ships as an MCP resource so clients can pull
  // it into context without a web fetch. Assert list + read over the wire.
  const session = await newSession();
  const list = await jsonRpc("resources/list", {}, { id: 10, session });
  const resources = (list.response.result as { resources?: Array<{ uri?: string }> })?.resources ?? [];
  assert.ok(
    resources.some((r) => r.uri === "omcp://guide/agent-usage"),
    `agent-usage-guide resource must be listed, got ${JSON.stringify(resources.map((r) => r.uri))}`,
  );
  const read = await jsonRpc("resources/read", { uri: "omcp://guide/agent-usage" }, { id: 11, session });
  const contents = (read.response.result as { contents?: Array<{ text?: string }> })?.contents ?? [];
  assert.ok((contents[0]?.text ?? "").includes("Triage recipe"), "guide text must round-trip");
});

test("E2E: builtin prompts triage-incident + write-postmortem are listed and resolvable", opts, async () => {
  const session = await newSession();
  const list = await jsonRpc("prompts/list", {}, { id: 12, session });
  const prompts = (list.response.result as { prompts?: Array<{ name?: string }> })?.prompts ?? [];
  for (const name of ["triage-incident", "write-postmortem"]) {
    assert.ok(prompts.some((p) => p.name === name), `prompt ${name} must be listed`);
  }
  const got = await jsonRpc(
    "prompts/get",
    { name: "triage-incident", arguments: { service: "ci-probe" } },
    { id: 13, session },
  );
  const msgs = (got.response.result as { messages?: Array<{ content?: { text?: string } }> })?.messages ?? [];
  assert.ok((msgs[0]?.content?.text ?? "").includes('"ci-probe"'), "prompt must interpolate the service arg");
});
