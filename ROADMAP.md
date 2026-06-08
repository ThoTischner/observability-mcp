# Roadmap

Where the project is going at a thematic level. For the connector-plugin engineering plan see [`docs/plugin-architecture.md`](docs/plugin-architecture.md).

Items here are **directions, not promises** — order will shift based on what users actually need. If something here matters to you, open a Discussion or an Issue.

## v3.1 — shipped 2026-06-08

The **Phase Q** sprint — closes the "Deferred to v3.x" backlog from
3.0. All additive / opt-in. See [CHANGELOG.md](CHANGELOG.md) for
per-capability detail and
[`docs/migrations/3.0-to-3.1.md`](docs/migrations/3.0-to-3.1.md).

- ✅ Concrete topology providers: AWS, GCP, Istio, Linkerd, Consul (on the v3.0 merger foundation)
- ✅ Federation upstream transports: stdio + WebSocket
- ✅ SCIM 2.0: Redis-backed store, PATCH add/remove on `members[]`/`emails[]`, full compliance suite
- ✅ Manifest-driven plugin hook auto-registration + resource/prompt hooks at the MCP seam
- ✅ S3-compatible audit sink + Redis-backed transport session map (sticky-ingress-free multi-replica)
- ✅ In-product Playground tab + Health-tab anomaly sparkline
- ✅ Security hardening: session revocation, per-account lockout, password policy, Content-Security-Policy
- ✅ Agent log analytics (issue #415): `query_logs` structured label filters + server-side aggregation (count/sum/topk)

### v3.2 — candidates

The remaining 3.0 deferred items, still open after 3.1 (vote via
Discussions):

- A custom postmortem template engine (persistence + the Postmortems UI tab already ship)
- SCIM filter/search on the collection endpoints + a UI Provisioning sub-tab
- Strict-mode MkDocs build (resolve the cross-repo link warnings)
- Raw PromQL/LogQL passthrough for agent analytics (issue #415 item #3) — gated behind a `raw_query` capability (label-selectors + aggregation already shipped in 3.1)

## v3.0 — shipped 2026-06-06

The moat-extension sprint on top of v2.0. See
[CHANGELOG.md](CHANGELOG.md) for per-capability detail.

- ✅ `query_traces` + `get_anomaly_history` + `generate_postmortem` MCP tools (8 → 11)
- ✅ Multi-cloud topology merger foundation + 8 reserved kinds (concrete cloud-provider connectors land as filesystem plugins in v3.x)
- ✅ Anomaly history TSDB sink + replay tool
- ✅ Batch policy dry-run + CSV export
- ✅ MkDocs Material documentation site at <https://thotischner.github.io/observability-mcp/>
- ✅ MCP Inspector quickstart (`omcp inspector-config`)
- ✅ SCIM 2.0 Users + Groups provisioning (Entra + Okta push)
- ✅ Plugin SDK published as `@thotischner/observability-mcp-sdk` + scaffolder CLI
- ✅ Verifiable-offline CI workflow (iptables-egress-blocked smoke test)
- ✅ Helm `airgapped: true` with egress-deny NetworkPolicy

## v4.x — next (open for community input)

The v3.x increments listed in [CHANGELOG.md](CHANGELOG.md) get
shipped first. Beyond that, the field is open — see the
[After-F23 candidates](#after-f23--candidates-for-the-next-sprint)
section of the [hub-parity sprint plan](https://github.com/ThoTischner/observability-mcp/tree/main/.claude/plans)
for the menu we'll pull from. Vote with thumbs-up emoji on the
Discussion threads if any of them matters to you.

## v2.0 — shipped 2026-06-06

The v2.0 release closed the remaining adoption-blocking gaps so a
single deployment is a complete MCP control plane. See
[CHANGELOG.md](CHANGELOG.md) for the per-capability detail.

- ✅ Upstream MCP federation (proxies other gateways' tools under a stable namespace)
- ✅ Multi-replica HA — shared session store + PodDisruptionBudget + sticky-ingress fallback
- ✅ WebSocket MCP transport at `/mcp/ws`
- ✅ Virtual MCP servers per Product at `/mcp/v/<id>`
- ✅ Plugin lifecycle hooks (`tool_pre_invoke` / `tool_post_invoke`)
- ✅ Pluggable audit sinks (Splunk/SIEM webhook with retries + DLQ)
- ✅ OpenTelemetry self-tracing
- ✅ MCP 2025-11-25 conformance harness + `GET /api/conformance` probe
- ✅ SSO vendor profiles (GitHub / Google / Microsoft Entra / Okta / Keycloak / generic)
- ✅ RFC 7591 Dynamic Client Registration
- ✅ Hardening — CSRF for SPA, SSRF strict-mode, plugin signature default-on

## v3.0 — next

A second sprint that extends the moats v2.0 secured. Track in
`/home/neo/.claude/plans/hub-parity-sprint.md` Phases F13–F23.

- `query_traces` MCP tool + Tempo/Jaeger integration
- Multi-cloud topology providers (AWS / GCP / Consul / Istio / Linkerd)
- TSDB-backed anomaly history for replay + post-mortem
- Batch policy dry-run probe
- MkDocs documentation site
- MCP Inspector quickstart
- Auto-generated post-mortem reports
- Plugin SDK as standalone npm package
- SCIM 2.0 provisioning
- Verifiable-offline CI (egress-blocked container)

## Earlier — landed

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
