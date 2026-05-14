# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Plugin system foundation** — `mcp-server/src/sdk/` barrel re-exporting the
  connector interface, manifest type, and a Zod schema for runtime validation.
  Filesystem `PluginLoader` (default `/app/plugins`) loads connectors at
  startup; the built-in Prometheus + Loki connectors run through the same
  loader as a builtin shim, so existing behaviour is unchanged.
- **`PLUGINS_DISABLED`** env (comma-separated names) short-circuits the
  loader. Useful for airgapped bundles where you ship every connector but
  enable only a subset.
- **`/metrics` Prometheus endpoint** powered by `prom-client@15`. Ships
  default Node metrics (`obsmcp_` prefix) plus product-specific counters
  for MCP tool calls, connector calls, API requests, and active sessions.
  Toggle with `METRICS_ENABLED=false`. Pairs with the chart's ServiceMonitor.
- **Helm chart** (`helm/observability-mcp/`) — ArtifactHub-grade chart with
  Deployment, Service, optional Ingress/PVC/HPA, NetworkPolicy, and
  ServiceMonitor (auto-gated on the Prometheus Operator CRD). Hardened pod
  security context. New `helm-release.yml` workflow publishes the chart to
  the `gh-pages` branch on every `v*` tag.
- **Plugin architecture design doc** at `docs/plugin-architecture.md`
  including the 8-PR implementation roadmap.
- **Web UI enterprise refresh — passes 1 and 2.** Refined slate palette,
  Inter variable font, real type/spacing scales, sticky header, status pulse
  on connected sources, modal/form polish, semantic health-card surfaces.
- **smithery.yaml** for Smithery.ai / catalog auto-imports.
- **SECURITY.md** + **CONTRIBUTING.md**.

### Changed
- **Branch protection on `main`** with six required checks
  (`smoke`, `unit-tests`, `npm-audit (mcp-server)`, `npm-audit (agent)`,
  `trivy`, `analyze (javascript-typescript)`).
- **Release flow** routed through a PR so the same checks gate releases.
  `auto-release.yml` opens a `chore(release): vX.Y.Z` PR, auto-merge takes
  it after checks pass, `tag-on-release.yml` pushes the tag, downstream
  workflows publish to npm and GHCR.
- **Auto-merge** for direct Dependabot patch/minor PRs is now zero-cooldown,
  gated entirely by the smoke test.
- **Integration smoke test** spins up the whole docker-compose stack on
  every PR and exercises the MCP Streamable HTTP handshake + `tools/list`
  against all six core tools.

### Fixed
- Transitive CVEs from `@modelcontextprotocol/sdk` (`fast-uri`, `hono`,
  `ip-address`, `@hono/node-server`) pinned via `npm overrides`.
- `escapeLogQLRegex` in the Loki connector now escapes backslashes before
  the regex delimiter (CodeQL `js/incomplete-sanitization`).
- Source/service identifiers routed through `sanitizeForLog()` before they
  enter log lines (CodeQL `js/log-injection`, `js/tainted-format-string`).
- Test temporary directories created via `mkdtempSync` instead of a
  predictable `tmpdir()` join (CodeQL `js/insecure-temporary-file`).

### Removed
- 64 spurious Code-Scanning alerts dismissed: Scorecard governance noise
  (workflow `permissions:`, pinned-by-SHA) and confirmed false positives
  (TLS opt-in, dynamic-method-call against a fixed factory map).

## [1.3.4] — earlier

Pre-changelog releases. See the GitHub Releases page and `git log` for
history before the changelog was introduced.
