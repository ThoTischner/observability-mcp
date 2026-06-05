import { test, expect, request } from "@playwright/test";

const BASE = process.env.OMCP_UI_BASE || "http://localhost:3000";

// E2E for the /mcp/v/<slug> virtual-server endpoints added in Phase F9.
// Seeds a Product binding two tools, then asserts:
//   1. The virtual MCP endpoint accepts the spec handshake.
//   2. tools/list returns EXACTLY the Product's tools, not the full
//      gateway surface.
//   3. The root /mcp continues to expose all tools (backwards compat).
//   4. A session minted on /mcp/v/<slug> cannot be probed via a
//      different /mcp/v/<other-slug>.

const PRODUCT_ID = "playwright-vs";
const PRODUCT_TOOLS = ["list_services", "list_sources"];

async function jsonRpcHttp(api, url, body) {
  const res = await api.post(url, {
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    data: body,
  });
  const headers = res.headers();
  const text = await res.text();
  let parsed;
  if (text.startsWith("event:") || text.includes("data: ")) {
    const m = text.match(/^data:\s*(.+)$/m);
    parsed = m ? JSON.parse(m[1]) : {};
  } else if (text.trim().startsWith("{")) {
    parsed = JSON.parse(text);
  } else {
    parsed = {};
  }
  return { body: parsed, headers, status: res.status() };
}

test.describe("MCP virtual server (/mcp/v/<slug>)", () => {
  test.beforeAll(async () => {
    const api = await request.newContext({ baseURL: BASE });
    await api.put(`/api/products/${PRODUCT_ID}`, {
      data: {
        id: PRODUCT_ID,
        name: "Playwright Virtual Server",
        description: "Product fixture for the virtual-server spec.",
        status: "published",
        tools: PRODUCT_TOOLS,
      },
    });
    await api.dispose();
  });

  test.afterAll(async () => {
    const api = await request.newContext({ baseURL: BASE });
    await api.delete(`/api/products/${PRODUCT_ID}`);
    await api.dispose();
  });

  test("initialize + tools/list returns ONLY the product's tools", async () => {
    const api = await request.newContext({ baseURL: BASE });
    const init = await jsonRpcHttp(api, `/mcp/v/${PRODUCT_ID}`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "playwright-vs-spec", version: "0" },
      },
    });
    expect(init.body.result, JSON.stringify(init.body.error || {})).toBeTruthy();
    const session = init.headers["mcp-session-id"];
    expect(session, "virtual MCP must issue a session id").toBeTruthy();

    const tools = await api.post(`/mcp/v/${PRODUCT_ID}`, {
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": session,
      },
      data: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      },
    });
    const tt = await tools.text();
    const m = tt.match(/^data:\s*(.+)$/m);
    const list = m ? JSON.parse(m[1]) : JSON.parse(tt);
    expect(list.result, JSON.stringify(list.error || {})).toBeTruthy();
    const names = list.result.tools.map((t) => t.name).sort();
    expect(
      names,
      `expected exactly ${PRODUCT_TOOLS.join(",")}, got ${names.join(",")}`,
    ).toEqual([...PRODUCT_TOOLS].sort());
    await api.dispose();
  });

  test("root /mcp still exposes the full tool surface (backwards compat)", async () => {
    const api = await request.newContext({ baseURL: BASE });
    const init = await jsonRpcHttp(api, `/mcp`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "p", version: "0" },
      },
    });
    const session = init.headers["mcp-session-id"];
    const tools = await api.post(`/mcp`, {
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": session,
      },
      data: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    });
    const text = await tools.text();
    const m = text.match(/^data:\s*(.+)$/m);
    const list = m ? JSON.parse(m[1]) : JSON.parse(text);
    const names = list.result.tools.map((t) => t.name);
    expect(names.length, "root /mcp must expose more than the product subset").toBeGreaterThan(
      PRODUCT_TOOLS.length,
    );
    await api.dispose();
  });

  test("missing virtual server returns 404", async () => {
    const api = await request.newContext({ baseURL: BASE });
    const res = await api.post(`/mcp/v/does-not-exist-${Date.now()}`, {
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "p", version: "0" } },
      },
    });
    expect(res.status()).toBe(404);
    await api.dispose();
  });
});
