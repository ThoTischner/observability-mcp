# observability-mcp

**A topology-aware MCP control plane for AI agents.** One self-hosted gateway:

- **observability tools** — `query_metrics`, `query_logs`, `query_traces`, `get_service_health`, `detect_anomalies`, `get_topology`, `get_blast_radius`, `get_anomaly_history`
- **federation** — proxy other MCP servers under one stable endpoint
- **governance** — RBAC, audit chain, tenancy, redaction, products, virtual servers
- **transports** — Streamable HTTP, stdio, WebSocket
- **air-gapped** — no runtime npm, signed plugins, offline-verifiable

## Try it in 30 seconds

```bash
docker compose --profile demo up --build
open http://localhost:3000
```

The demo brings up a k3s cluster, Prometheus + Loki scraping it, and the gateway pre-wired against the lot. The web UI lands on the Dashboard.

## Plug an agent into it

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

Drop the snippet into Claude Desktop / Cursor / any MCP client; the eight observability tools become visible on `tools/list`.

## What's where

- **[Getting started](getting-started.md)** — install, configure, first tool call.
- **[Install via Helm](install-helm.md)** — `helm repo add` + values + signature verification.
- **[Configuration](configuration.md)** — `sources.yaml`, env vars, hot-reload.
- **[Topology vocabulary](topology-vocabulary.md)** — the shared graph language every connector speaks.
- **[Federation](federation.md)** — fan tools out from upstream MCP gateways.
- **[Access control](access-control.md)** — RBAC, OIDC SSO, audit, redaction.
- **[Hardening](hardening.md)** — CSRF / SSRF posture; the security defaults.
- **[Migration guide](migrations/1.x-to-2.0.md)** — upgrading from 1.x.

## What ships in v2.0

See the [v2.0 CHANGELOG entry](https://github.com/ThoTischner/observability-mcp/blob/main/CHANGELOG.md#200--2026-06-06) — federation, multi-replica HA, WebSocket transport, OIDC vendor presets, plugin lifecycle hooks, pluggable audit sinks, OTel self-tracing, MCP 2025-11-25 conformance, virtual servers, CSRF + SSRF hardening, plugin signature default-on.
