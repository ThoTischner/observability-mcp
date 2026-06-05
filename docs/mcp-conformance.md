# MCP spec conformance

The gateway ships a conformance harness that proves every release
upholds the MCP 2025-11-25 wire contract. The same suite runs:

1. **Locally** via `make conformance` (boots the demo, hits /mcp, runs `node:test`).
2. **In CI** as a required check on every PR (`.github/workflows/integration.yml`).
3. **At a glance** via `GET /api/conformance` — returns the supported revisions, transports, and method list for procurement / discovery probes.

## What's covered

The harness file
[`mcp-server/src/conformance/mcp-2025-11-25.test.ts`](../mcp-server/src/conformance/mcp-2025-11-25.test.ts)
exercises:

| Method / requirement | Assertion |
|---|---|
| `initialize` | InitializeResult shape, `protocolVersion` date format, `serverInfo.name+version`, `Mcp-Session-Id` header issued |
| `notifications/initialized` | Accepted, no error |
| `ping` | Returns a (possibly empty) result |
| `tools/list` | Returns `Tool[]` with `name` and `inputSchema` per entry |
| `tools/call` | Dispatches; returns either `CallToolResult.content[]` or a JSON-RPC error |
| `tools/call` (invalid params) | Either `-32602` error OR an `isError`/shape-conformant `CallToolResult` |
| Unknown method | Returns `-32601 Method not found` |
| `resources/list` | If supported, returns `Resource[]`; if not, returns `-32601` |
| `prompts/list` | If supported, returns `Prompt[]`; if not, returns `-32601` |
| `logging/setLevel` | If supported, accepts spec levels; if not, returns `-32601` |
| Protocol version | `YYYY-MM-DD` date string |

The harness is deliberately permissive about **optional** methods (it
accepts `-32601` for any spec-optional capability) and strict about
**mandatory** ones (a spec-required envelope mismatch breaks the
build).

## Running it

### Against a running demo

```bash
make demo            # bring the stack up if not already running
make conformance     # waits for /healthz, runs the harness
```

### Against an arbitrary deployment

```bash
OMCP_CONFORMANCE_URL=https://gateway.example.internal/mcp \
  npx --yes tsx --test \
  mcp-server/src/conformance/mcp-2025-11-25.test.ts
```

When `OMCP_CONFORMANCE_URL` is unset, every test skips — the file is
safe to include in the default `node:test` discovery glob.

## `GET /api/conformance`

Returns a static JSON document describing the gateway's spec posture:

```json
{
  "revisions": ["2025-11-25"],
  "transports": ["streamable-http", "stdio", "websocket"],
  "methods": {
    "supported": ["initialize", "notifications/initialized", "ping", "tools/list", "tools/call"],
    "optional":  ["resources/list", "resources/read", "prompts/list", "prompts/get", "logging/setLevel"]
  },
  "harnessPath": "mcp-server/src/conformance/mcp-2025-11-25.test.ts",
  "docs": "docs/mcp-conformance.md"
}
```

Procurement probes and catalog scanners can resolve this without a
real MCP handshake. The harness path is published so any consumer can
reproduce the assertions against their own deployment.

## When a new spec revision drops

1. Copy `mcp-2025-11-25.test.ts` to `mcp-<new-date>.test.ts`.
2. Update the test for whatever the new revision changes.
3. Add the new date to `revisions[]` in `/api/conformance`.
4. Keep the old harness running in CI until the next release cycle so
   regression coverage doesn't drop while clients migrate.
