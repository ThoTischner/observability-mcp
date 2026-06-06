# Getting started

## Run the demo

```bash
docker compose --profile demo up --build
```

That brings up:

- a single-node k3s cluster with three chaos-able example services
  (`api-gateway`, `payment-service`, `order-service`)
- Prometheus + Loki scraping the cluster
- the gateway pre-wired against k3s + Prometheus + Loki
- an optional autonomous detection agent (also part of the demo
  profile)

Land on <http://localhost:3000>. The Web UI Dashboard tab is the
first thing to look at; Sources / Services / Health / Topology fill
in as the cluster warms up.

## Speak MCP from the command line

```bash
# Initialize handshake
curl -sS http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# tools/list (use the mcp-session-id header from the initialize response)
SESSION=...
curl -sS http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SESSION" \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

The full conformance harness — including every method the gateway
should respond to — lives at
[`mcp-server/src/conformance/mcp-2025-11-25.test.ts`](https://github.com/ThoTischner/observability-mcp/blob/main/mcp-server/src/conformance/mcp-2025-11-25.test.ts).

## Connect an MCP client

For Claude Desktop / Cursor / any MCP client that loads a config:

```jsonc
{
  "mcpServers": {
    "observability": {
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer <key>" }
    }
  }
}
```

(Anonymous-auth mode accepts any non-empty bearer token. Configure
`OMCP_API_KEYS` for real deployments — see
[access control](access-control.md).)

## Wire your own backends

Edit `mcp-server/config/sources.yaml` (or use the Sources tab in the
Web UI; both update the same file and hot-reload):

```yaml
sources:
  - name: prod-prom
    type: prometheus
    url: https://prometheus.your-cluster.internal/
    enabled: true
  - name: prod-loki
    type: loki
    url: https://loki.your-cluster.internal/
    enabled: true
```

See [configuration](configuration.md) for the full schema and
[connectors](connectors.md) for the per-backend specifics.

## Next steps

- [Access control](access-control.md) — RBAC, OIDC, audit
- [Federation](federation.md) — proxy upstream MCP servers
- [Horizontal scaling](horizontal-scaling.md) — multi-replica HA
- [Hardening](hardening.md) — security defaults
