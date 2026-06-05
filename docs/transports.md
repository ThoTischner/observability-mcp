# MCP Transports

The gateway speaks the Model Context Protocol over three transports.
Pick the one that matches your client and your network:

| Transport | URL / Mode | When to use |
|---|---|---|
| **Streamable HTTP** | `POST /mcp` + `GET /mcp` (session-id header) | Default for modern MCP clients (Claude Code, Claude Desktop, Cursor, recent SDKs). |
| **WebSocket** | `ws://host:3000/mcp/ws` | Bidirectional clients that prefer a persistent socket (custom UIs, browser-side agents, environments where long-polling is awkward). |
| **stdio** | `omcp --stdio` or `MCP_TRANSPORT=stdio` | Local subprocess invocation (MCP catalogs, desktop clients that spawn the server, MCP Inspector). |

All three serve the same tool surface — pick whichever your client supports best.

## Streamable HTTP

The canonical transport defined by the MCP 2025-11-25 spec. The gateway
manages session state per `mcp-session-id` header; the client posts
JSON-RPC requests and reads streamed responses on the same session.

Auth: `Authorization: Bearer <token>` or `X-API-Key: <token>` (when
`OMCP_API_KEYS` is configured). Anonymous traffic is rejected with
`401` unless the server runs in anonymous mode.

Rate limits: `X-RateLimit-*` headers on every response.

## WebSocket

One JSON-RPC frame per WebSocket text message. The gateway opens one
`McpServer` instance per accepted socket and reaps it when the
connection closes.

### Connecting

```text
ws://host:3000/mcp/ws
```

For TLS:

```text
wss://host:3000/mcp/ws
```

### Authenticating

WebSocket upgrade requests from browsers cannot set an `Authorization`
header, so three token sources are accepted in order of precedence:

1. **`Authorization: Bearer <token>`** — for server-to-server clients
   that control the upgrade headers.
2. **`?token=<token>`** — URL query string, useful in browsers.
3. **`Sec-WebSocket-Protocol: bearer.<token>`** — for clients that
   prefer to keep the token out of access logs.

If none of the above resolves to a configured credential, the gateway
accepts the upgrade just long enough to close with WS close code
`1008` (`policy violation`) and a reason string. Rate-limited
identities close with `1013` (`try again later`).

### Heartbeat

The gateway pings every 30 seconds and closes the socket with
`1001` (`going away`) if no pong arrives within 90 seconds. Clients
that go silent (NAT drop, suspended laptop) are reaped automatically.

### Wire format

Each WS text frame carries one JSON-RPC envelope, identical in shape
to the body of an HTTP POST to `/mcp`. Batched arrays are fanned out
into individual messages, matching Streamable HTTP semantics. Binary
frames are rejected with an out-of-band error but do not close the
socket.

### Example: Node.js

```js
import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:3000/mcp/ws", {
  headers: { Authorization: "Bearer " + process.env.OMCP_TOKEN },
});

ws.on("open", () => {
  ws.send(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "demo", version: "0" } },
  }));
});

ws.on("message", (data) => {
  console.log("←", data.toString());
});
```

### Example: browser

```js
const ws = new WebSocket(
  `ws://localhost:3000/mcp/ws?token=${encodeURIComponent(token)}`
);
ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
ws.onmessage = (ev) => console.log("←", ev.data);
```

## stdio

For local subprocess clients (MCP catalogs, desktop clients, MCP
Inspector), launch the server with `--stdio` or
`MCP_TRANSPORT=stdio` and read/write JSON-RPC on the child's
stdin/stdout. The gateway routes its own logs to stderr so the
protocol stream is uncontaminated.

```bash
npx omcp --stdio
```

Auth is not enforced for stdio (the parent process controls the
spawn and is implicitly trusted).

## Choosing

- Most agents and IDE plugins use **Streamable HTTP** by default.
- Use **WebSocket** when your client wants a persistent socket or runs
  in a browser that can't easily set custom HTTP headers.
- Use **stdio** when the gateway is spawned as a child process for a
  single client session.
