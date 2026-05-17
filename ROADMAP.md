# Roadmap

Where the project is going at a thematic level. For the connector-plugin engineering plan see [`docs/plugin-architecture.md`](docs/plugin-architecture.md).

Items here are **directions, not promises** — order will shift based on what users actually need. If something here matters to you, open a Discussion or an Issue.

## Now — landed

- ✅ MCP Streamable HTTP transport with all 6 tools
- ✅ Prometheus + Loki as filesystem plugins (PluginLoader + Zod manifest schema)
- ✅ Web UI Dashboard / Sources / Services / Health / Settings
- ✅ **Robust analysis engine** — median/MAD anomaly detection with trend + warmup + dwell, seasonality-aware baselines, dependency-aware root-cause ranking, memory/OOM coverage
- ✅ **Backtested quality gate** — labelled synthetic suite scored in CI; precision / recall / F1 published in the README and regenerated from the suite so they cannot drift
- ✅ OpenAPI 3.1 + `/healthz` + `/readyz` + `/metrics`
- ✅ Helm chart with NetworkPolicy, ServiceMonitor, `values.schema.json`, GPG-signed packages
- ✅ Airgapped deployment story (no runtime npm, plugin tarballs baked into the image)
- ✅ SBOM + SLSA provenance attestations on every image

## Next

- **Embeddable analysis library.** The same deterministic analysis engine usable in-process as a library, not only via the MCP transport — for teams that want the verdicts without running the gateway.
- **Verifiable offline mode.** A first-class "no data egress" guarantee: offline-by-default, and a CI test that runs the server in an egress-blocked network to prove it.
- **Sovereign quickstart.** One-command, fully on-prem demo running next to a local model (no external calls), showing analyzed context vs raw queries end to end.
- **Access control on sources & tools.** Per-credential scoping (RBAC): a given MCP connection can be restricted to specific sources, specific tools, read-only, and optional service/metric allow-lists and look-back caps. Replaces today's "every session sees everything".
- **More built-in connectors.** Grafana Mimir / Cortex, VictoriaMetrics, OpenSearch / Elasticsearch logs, OpenTelemetry, **Datadog** (read-only). Driven by user demand — see [discussion #97](https://github.com/ThoTischner/observability-mcp/discussions/97).
- **Traces as a first-class signal.** Tempo / Jaeger / OTLP connector. `query_traces` MCP tool joining the existing six. Correlator extended to metrics ↔ logs ↔ traces.
- **Framework adapters.** Thin wrappers so users on LangChain / LlamaIndex can register the six tools without learning the MCP transport directly.
- **Claude Skill.** Publish observability-mcp as an [Anthropic Skill](https://docs.anthropic.com/en/docs/build-with-claude/skills).
- **Plugin SDK on npm.** Published independently so anyone can write a connector in their own repo without forking us.
- **Plugin signature verification.** `PLUGIN_REQUIRE_SIGNATURE=true` mode rejecting unsigned tarballs at load time (Sigstore keyless OIDC).

## Later

- **Curated tool/source bundles ("products").** Publish a scoped, versioned set of tools over selected sources as its own addressable MCP endpoint with its own credential — so an agent gets exactly the access it needs, nothing more. A catalog to author, version, and browse them.
- **Structured audit log.** A queryable record of every tool call (which principal, which sources touched, which tool, allow/deny) for teams that need to evidence agent access.
- **Multi-tenant gateway mode.** One server, isolated per-tenant sources and credentials. For platform teams running observability-access-as-a-service.
- **Connector Hub catalog.** Registry where users discover and install connectors with one command.
- **Native incident artefacts.** Auto-generated post-mortems from a sequence of `detect_anomalies` + `query_logs` calls, persisted as markdown.
- **Server-side score history.** A small TSDB-backed history so `get_service_health` returns trends that survive reloads.

## Not on the roadmap (yet)

- A hosted SaaS version — the project is intentionally self-hosted-first.
- A custom query language. Each connector owns its own (PromQL, LogQL, …). We resist building a lossy IR on top.
- Replacing Grafana / Datadog / Elastic for humans. We're a gateway for AI agents — the dashboards stay where they are.

## How to influence this

- Open a [Discussion](https://github.com/ThoTischner/observability-mcp/discussions) — best for direction questions and "would you accept a PR that …"
- Open an [Issue](https://github.com/ThoTischner/observability-mcp/issues) — best for concrete bugs or missing features
- Send a PR — connectors especially welcome; the interface is one file
