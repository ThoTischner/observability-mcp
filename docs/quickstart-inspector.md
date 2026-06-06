# Quickstart: MCP Inspector

The official [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
is the fastest way to explore a fresh gateway: it speaks every MCP
method interactively, renders tool input-schemas as forms, and
displays the raw JSON-RPC frames side-by-side with the parsed
response.

## 30-second start

The gateway ships a CLI subcommand that emits the exact Inspector
config for the local server. Pipe it straight in:

```bash
# Boot the demo
docker compose --profile demo up -d --build

# Generate + feed Inspector
npx --yes @modelcontextprotocol/inspector \
  --config <(npx --yes @thotischner/observability-mcp inspector-config)
```

Or write to a file first:

```bash
npx @thotischner/observability-mcp inspector-config > inspector.json
npx --yes @modelcontextprotocol/inspector --config inspector.json
```

The Inspector opens at <http://localhost:6274> by default. Pick
`observability-mcp` from the server dropdown and:

1. **Initialize** → handshake auto-fires on connect.
2. **Tools → List** → see the 10 native tools (plus any federated).
3. **Tools → Call** → pick `list_services`, hit Run. The form is
   generated from the tool's `inputSchema`.

## Pointing at a remote gateway

`inspector-config` reads three env vars:

| Env | Default | Meaning |
|---|---|---|
| `OMCP_BASE_URL` | `http://localhost:3000` | Server base; `/mcp` appended. |
| `OMCP_INSPECTOR_TOKEN` | unset | Bearer token put in `Authorization` header. |
| `OMCP_INSPECTOR_SERVER_NAME` | `observability-mcp` | Display label in Inspector's server dropdown. |

```bash
OMCP_BASE_URL=https://gateway.example.internal \
OMCP_INSPECTOR_TOKEN=$(cat ~/.omcp/dev-token) \
OMCP_INSPECTOR_SERVER_NAME=prod-gateway \
  npx @thotischner/observability-mcp inspector-config
```

## Why this exists

Without the subcommand, every new developer has to:

1. Read the MCP transports doc.
2. Remember the right session-id header pattern.
3. Hand-craft an Inspector config JSON.
4. Re-craft it whenever a port changes.

The subcommand collapses that to one line and keeps the config
honest — the URL and headers always match what the gateway expects
because they're computed from the same env vars.

## Related

- [`docs/dev-loop.md`](dev-loop.md) — adding a new tool / connector
- [`docs/transports.md`](transports.md) — when to use Streamable HTTP / WebSocket / stdio
- [`docs/mcp-conformance.md`](mcp-conformance.md) — the spec the gateway claims to implement
