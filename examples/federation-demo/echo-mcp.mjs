#!/usr/bin/env node
// Minimal, dependency-free MCP server over stdio — a deliberately NON-observability
// upstream (echo / add / whoami) used to demonstrate federation: the observability
// gateway federates this and surfaces its tools as `demo.<tool>` on its own /mcp.
//
// MCP stdio transport = newline-delimited JSON-RPC 2.0 on stdin/stdout.
// Anything that isn't a protocol message goes to stderr so stdout stays clean.

import { stdin, stdout, stderr } from "node:process";

const log = (m) => stderr.write(`[demo-mcp] ${m}\n`);

const TOOLS = [
  {
    name: "echo",
    description: "Echo back the provided message (demo upstream — not an observability tool).",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  },
  {
    name: "add",
    description: "Add two numbers and return the sum (demo upstream).",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
  },
  {
    name: "whoami",
    description: "Identify this federated upstream server.",
    inputSchema: { type: "object", properties: {} },
  },
];

function callTool(name, args = {}) {
  if (name === "echo") return `echo: ${String(args.message ?? "")}`;
  if (name === "add") return `sum = ${Number(args.a) + Number(args.b)}`;
  if (name === "whoami") return "I am demo-echo-mcp — a separate MCP server, federated behind observability-mcp.";
  throw new Error(`unknown tool: ${name}`);
}

function send(msg) {
  stdout.write(JSON.stringify(msg) + "\n");
}

function handle(req) {
  const { id, method, params } = req;
  // Notifications (no id) — acknowledge by doing nothing.
  if (id === undefined || id === null) return;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "demo-echo-mcp", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    try {
      const text = callTool(params?.name, params?.arguments || {});
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
    } catch (e) {
      send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: String(e.message || e) }] } });
    }
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  // Unknown method → JSON-RPC method-not-found.
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

let buf = "";
stdin.setEncoding("utf8");
stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); }
    catch (e) { log(`parse error: ${e.message}`); }
  }
});
stdin.on("end", () => process.exit(0));
log("ready (echo/add/whoami) on stdio");
