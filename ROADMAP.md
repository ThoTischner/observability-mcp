# Roadmap

Where the project is going at a thematic level. For the connector-plugin engineering plan see [`docs/plugin-architecture.md`](docs/plugin-architecture.md).

Items here are **directions, not promises** — order will shift based on what users actually need. If something here matters to you, open a Discussion or an Issue.

## Now — landed in v1.4.0

- ✅ MCP Streamable HTTP transport with all 6 tools
- ✅ Prometheus + Loki as filesystem plugins (PluginLoader + Zod manifest schema)
- ✅ Web UI Dashboard / Sources / Services / Health / Settings — enterprise refresh complete
- ✅ Cross-signal anomaly detection (z-score) and health scoring
- ✅ OpenAPI 3.1 + `/healthz` + `/readyz` + `/metrics`
- ✅ Helm chart with NetworkPolicy, ServiceMonitor, `values.schema.json`, GPG-signed packages
- ✅ Airgapped deployment story (no runtime npm, plugin tarballs baked into the image)
- ✅ SBOM + SLSA provenance attestations on every image

## Next — Q3 2026

- **More built-in connectors.** Grafana Mimir / Cortex (Prometheus-compatible but with multi-tenant headers), VictoriaMetrics, OpenSearch / Elasticsearch logs. Driven by user demand — see [discussion #97](https://github.com/ThoTischner/observability-mcp/discussions/97).
- **Traces as a first-class signal.** Tempo / Jaeger / OTLP connector. `query_traces` MCP tool joining the existing six. Cross-signal correlator extended to metrics ↔ logs ↔ traces.
- **Plugin SDK on npm.** `@thotischner/observability-mcp-sdk` published independently so anyone can write a connector in their own repo without forking us. Roadmap step 6.
- **Plugin signature verification.** `PLUGIN_REQUIRE_SIGNATURE=true` mode that rejects unsigned tarballs at load time. Sigstore keyless OIDC; step 7 in the plugin architecture.

## Later — 2026/2027

- **Connector Hub catalog.** Confluent-Hub-style registry where users discover and install connectors with one command. Manifest schema + registration flow + UI. Roadmap step 9.
- **Multi-tenant gateway mode.** One server, namespace-scoped sources, per-tenant auth. For platform teams running observability-as-a-service.
- **AuthZ on tools, not just transport.** Fine-grained policy on which MCP tools each client can call, per source.
- **Native incident artefacts.** Auto-generated post-mortems from a sequence of `detect_anomalies` + `query_logs` calls, persisted as markdown.
- **Server-side score history.** Right now the dashboard sparklines are client-side (~7.5 min). A small TSDB-backed history would survive page reloads and let `get_service_health` return trends.

## Not on the roadmap (yet)

- A hosted SaaS version — the project is intentionally self-hosted-first. Mirror this if you want SaaS.
- A custom query language. Each connector owns its own (PromQL, LogQL, …). We resist building a lossy IR on top.
- Replacing Grafana / Datadog / Elastic for humans. We're a gateway for AI agents — the dashboards stay where they are.

## How to influence this

- Open a [Discussion](https://github.com/ThoTischner/observability-mcp/discussions) — best for direction questions and "would you accept a PR that …"
- Open an [Issue](https://github.com/ThoTischner/observability-mcp/issues) — best for concrete bugs or missing features
- Send a PR — connectors especially welcome; the interface is one file
