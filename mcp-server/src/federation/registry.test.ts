import { test } from "node:test";
import assert from "node:assert/strict";

import { FederationRegistry, parseFederationEnv } from "./registry.js";
import type { UpstreamClient, UpstreamToolInfo, UpstreamStatus } from "./upstream.js";

// Minimal fake UpstreamClient. The real Client requires a live HTTP
// upstream; this fake satisfies the shape FederationRegistry actually
// touches.
class FakeUpstream {
  name: string;
  url = "https://fake/mcp";
  namespacePrefix: string;
  private tools: UpstreamToolInfo[];
  private callLog: Array<{ tool: string; args: unknown }> = [];
  closed = false;
  constructor(name: string, prefix: string, toolNames: string[]) {
    this.name = name;
    this.namespacePrefix = prefix;
    this.tools = toolNames.map((n) => ({
      namespacedName: `${prefix}.${n}`,
      upstreamName: n,
      sourceName: name,
      description: `upstream tool ${n}`,
      inputSchema: {},
    }));
  }
  getTools(): UpstreamToolInfo[] {
    return [...this.tools];
  }
  async callTool(upstreamName: string, args: unknown): Promise<unknown> {
    this.callLog.push({ tool: upstreamName, args });
    return { result: { echo: upstreamName, args } };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  getStatus(): { status: UpstreamStatus; toolCount: number } {
    return { status: "ready", toolCount: this.tools.length };
  }
  async connect(): Promise<void> {
    /* no-op for tests */
  }
  async refresh(): Promise<void> {
    /* no-op */
  }
  log(): typeof this.callLog {
    return this.callLog;
  }
}

function fakeAsClient(f: FakeUpstream): UpstreamClient {
  return f as unknown as UpstreamClient;
}

test("FederationRegistry: add + list + get", () => {
  const reg = new FederationRegistry();
  const u = new FakeUpstream("a", "a", ["x"]);
  reg.add(fakeAsClient(u));
  assert.equal(reg.list().length, 1);
  assert.equal(reg.get("a")?.name, "a");
});

test("FederationRegistry: add of duplicate name throws", () => {
  const reg = new FederationRegistry();
  reg.add(fakeAsClient(new FakeUpstream("a", "a", [])));
  assert.throws(() => reg.add(fakeAsClient(new FakeUpstream("a", "a", []))), /already registered/);
});

test("FederationRegistry: getNamespacedTools flattens across upstreams with stable order", () => {
  const reg = new FederationRegistry();
  reg.add(fakeAsClient(new FakeUpstream("a", "a", ["x", "y"])));
  reg.add(fakeAsClient(new FakeUpstream("b", "b", ["z"])));
  const names = reg.getNamespacedTools().map((t) => t.namespacedName);
  assert.deepEqual(names, ["a.x", "a.y", "b.z"]);
});

test("FederationRegistry: callNamespacedTool routes to the owning upstream", async () => {
  const a = new FakeUpstream("a", "a", ["x"]);
  const b = new FakeUpstream("b", "b", ["z"]);
  const reg = new FederationRegistry();
  reg.add(fakeAsClient(a));
  reg.add(fakeAsClient(b));
  await reg.callNamespacedTool("b.z", { foo: 1 });
  assert.equal(a.log().length, 0);
  assert.deepEqual(b.log(), [{ tool: "z", args: { foo: 1 } }]);
});

test("FederationRegistry: callNamespacedTool throws on unknown tool", async () => {
  const reg = new FederationRegistry();
  reg.add(fakeAsClient(new FakeUpstream("a", "a", ["x"])));
  await assert.rejects(() => reg.callNamespacedTool("a.nope", {}), /not found/);
});

test("FederationRegistry: remove + closeAll", async () => {
  const a = new FakeUpstream("a", "a", []);
  const reg = new FederationRegistry();
  reg.add(fakeAsClient(a));
  reg.remove("a");
  assert.equal(reg.list().length, 0);

  const b = new FakeUpstream("b", "b", []);
  reg.add(fakeAsClient(b));
  await reg.closeAll();
  assert.equal(b.closed, true);
  assert.equal(reg.list().length, 0);
});

test("parseFederationEnv: returns [] for missing / empty", () => {
  assert.deepEqual(parseFederationEnv({}), []);
  assert.deepEqual(parseFederationEnv({ OMCP_FEDERATION_UPSTREAMS: "" }), []);
  assert.deepEqual(parseFederationEnv({ OMCP_FEDERATION_UPSTREAMS: "   " }), []);
});

test("parseFederationEnv: parses name=url comma-separated entries", () => {
  const parsed = parseFederationEnv({
    OMCP_FEDERATION_UPSTREAMS: "a=https://gw.a/mcp,b=https://gw.b/mcp",
  });
  assert.deepEqual(parsed, [
    { kind: "http", name: "a", url: "https://gw.a/mcp", bearerToken: undefined },
    { kind: "http", name: "b", url: "https://gw.b/mcp", bearerToken: undefined },
  ]);
});

test("parseFederationEnv: picks up bearer token per OMCP_FEDERATION_TOKEN_<NAME>", () => {
  const parsed = parseFederationEnv({
    OMCP_FEDERATION_UPSTREAMS: "prod=https://gw.prod/mcp",
    OMCP_FEDERATION_TOKEN_PROD: "secret-token-xyz",
  });
  assert.equal(parsed[0]?.kind, "http");
  if (parsed[0]?.kind === "http") {
    assert.equal(parsed[0].bearerToken, "secret-token-xyz");
  }
});

test("parseFederationEnv: stdio:<command> entries parse with kind=stdio", () => {
  const parsed = parseFederationEnv({
    OMCP_FEDERATION_UPSTREAMS: "local=stdio:/usr/local/bin/mcp",
  });
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], {
    kind: "stdio",
    name: "local",
    command: "/usr/local/bin/mcp",
    args: [],
  });
});

test("parseFederationEnv: stdio command args split on whitespace", () => {
  const parsed = parseFederationEnv({
    OMCP_FEDERATION_UPSTREAMS: "weather=stdio:node weather-mcp.js --port 0",
  });
  assert.equal(parsed[0]?.kind, "stdio");
  if (parsed[0]?.kind === "stdio") {
    assert.equal(parsed[0].command, "node");
    assert.deepEqual(parsed[0].args, ["weather-mcp.js", "--port", "0"]);
  }
});

test("parseFederationEnv: backslash-escapes preserve spaces in stdio commands", () => {
  const parsed = parseFederationEnv({
    OMCP_FEDERATION_UPSTREAMS: "x=stdio:/opt/path\\ with\\ spaces/mcp arg1",
  });
  assert.equal(parsed[0]?.kind, "stdio");
  if (parsed[0]?.kind === "stdio") {
    assert.equal(parsed[0].command, "/opt/path with spaces/mcp");
    assert.deepEqual(parsed[0].args, ["arg1"]);
  }
});

test("parseFederationEnv: stdio with no command after stdio: is skipped", () => {
  const parsed = parseFederationEnv({
    OMCP_FEDERATION_UPSTREAMS: "broken=stdio:",
  });
  assert.equal(parsed.length, 0);
});

test("parseFederationEnv: http + stdio entries co-exist", () => {
  const parsed = parseFederationEnv({
    OMCP_FEDERATION_UPSTREAMS: "remote=https://gw/mcp,local=stdio:mcp",
  });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.kind, "http");
  assert.equal(parsed[1]?.kind, "stdio");
});

test("parseFederationEnv: ws:// + wss:// entries parse with kind=ws", () => {
  const parsed = parseFederationEnv({
    OMCP_FEDERATION_UPSTREAMS: "plain=ws://gw/mcp/ws,secure=wss://gw/mcp/ws",
  });
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { kind: "ws", name: "plain", url: "ws://gw/mcp/ws" });
  assert.deepEqual(parsed[1], { kind: "ws", name: "secure", url: "wss://gw/mcp/ws" });
});

test("parseFederationEnv: ws upstreams do NOT carry bearer tokens (URL-only)", () => {
  // Even when a matching OMCP_FEDERATION_TOKEN_X is set, the ws entry
  // shouldn't grow a bearerToken field — the SDK transport only
  // accepts the URL.
  const parsed = parseFederationEnv({
    OMCP_FEDERATION_UPSTREAMS: "x=wss://gw/mcp/ws",
    OMCP_FEDERATION_TOKEN_X: "would-be-ignored",
  });
  assert.equal(parsed[0]?.kind, "ws");
  // The ws branch has no `bearerToken` property at all.
  assert.equal((parsed[0] as unknown as Record<string, unknown>).bearerToken, undefined);
});

test("parseFederationEnv: all four transport variants co-exist", () => {
  const parsed = parseFederationEnv({
    OMCP_FEDERATION_UPSTREAMS:
      "a=https://gw/mcp,b=http://gw/mcp,c=ws://gw/mcp/ws,d=stdio:/bin/mcp",
  });
  assert.equal(parsed.length, 4);
  assert.deepEqual(
    parsed.map((p) => p.kind),
    ["http", "http", "ws", "stdio"],
  );
});

test("parseFederationEnv: skips malformed entries with a warning, keeps the rest", () => {
  const parsed = parseFederationEnv({
    OMCP_FEDERATION_UPSTREAMS:
      "good=https://gw/mcp,no-equals,bad-url=ftp://x,a=https://b/mcp",
  });
  // Only `good=` and `a=` survive
  assert.deepEqual(
    parsed.map((p) => p.name),
    ["good", "a"],
  );
});

test("parseFederationEnv: rejects invalid names (must start with letter)", () => {
  const parsed = parseFederationEnv({
    OMCP_FEDERATION_UPSTREAMS: "1bad=https://x/mcp,_also=https://y/mcp,ok=https://z/mcp",
  });
  assert.deepEqual(
    parsed.map((p) => p.name),
    ["ok"],
  );
});
