# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Patch-level refinements on top of 1.8.0. None of these break existing
deployments — operators upgrading from 1.8.0 see only additive surface
plus stricter redaction by default.

### Added
- **`GET /api/policy`** (admin-only) — read-only view of the active
  `DEFAULT_POLICY` so operators can debug "why did role X get a 403?"
  without a source checkout. #246
- **`GET /api/usage`** — per-identity windowed call-count snapshot for
  `/mcp` callers, gated by `audit:read`. #244
- **AWS access keys, Slack tokens, GitHub PATs and PEM private-key
  blocks** added to the `query_logs` redactor. The four new patterns
  run before the generic `api-key` matcher so their distinctive
  prefixes win. #243
- **`scripts/verify-audit.mjs`** — offline audit-chain verifier
  (pure node built-ins, no `node_modules` needed). Exits 0 on a clean
  chain and 1 with `{ brokenAt, reason }` on the first failure.
  Six `node:test` end-to-end cases pin the CLI behaviour contract.
  #240, #242
- **15s auto-refresh** on the Audit Log / Access Control / Products /
  Entitlement pages, gated on `.active` + `document.hidden` so
  backgrounded tabs go quiet. #241
- **Per-row source actions hidden for viewers** — closes the E2 follow-up
  the reviewer flagged in #231. Edit / Delete / toggle buttons in each
  source row now carry `data-rbac` and respect the current user's
  permission set the same way the static dashboard CTAs do. #239
- **OpenAPI 3.1 spec covers the six new `/api/*` endpoints** added in
  v1.8.0 — operators importing the spec into Insomnia / Postman /
  OpenAPI codegens now see `/api/me`, `/api/auth/{login,logout}`,
  `/api/audit`, `/api/usage`, `/api/catalog`, `/api/policy`. #245

## [1.8.0] — 2026-05-28

A governance-and-polish release. Everything ships **off by default** —
existing single-user demos keep working exactly as before — but the
opt-in machinery for multi-user enterprise deployments is now complete.

### Added — governance plane (#229–#237)

- **Basic-mode auth** (`OMCP_AUTH=basic` + `OMCP_USERS_FILE`): signed
  HttpOnly session cookies, scrypt-hashed local users, login flow in
  the Web UI with global fetch-wrapper that catches
  `401 OMCP_AUTH_REQUIRED` and replays the original request after
  sign-in. `scripts/hash-password.mjs` mints users without a host
  npm install. Fail-CLOSED on misconfig (override via
  `OMCP_AUTH_ALLOW_FALLBACK`). Docs:
  [auth-basic.md](docs/auth-basic.md). PRs #229, #230.
- **Role-based access control** with built-in viewer / operator / admin
  roles. Per-route `need(resource, action)` gates wired onto 11
  mutating `/api/*` routes. `/api/me` surfaces granted permissions so
  the Web UI hides write controls users can't operate. PR #231.
- **Tamper-evident audit log** — JSONL with a SHA-256 hash chain,
  replayed on restart so seq / tipHash resume cleanly.
  `OMCP_MGMT_AUDIT_FILE` toggles file persistence; otherwise an
  in-memory ring of the last 500 entries serves the new
  `GET /api/audit` endpoint. Renders on the Audit Log page alongside
  the existing entitlement-gate feed. PR #232.
- **Service catalog** (`OMCP_SERVICE_CATALOG_FILE`) — operator-curated
  ownership / criticality / on-call / SLO metadata, hooked into
  `/api/services`, `/api/health`, and the `list_services` /
  `get_service_health` MCP tools so the agent sees the same context
  the operator does. PR #233.
- **PII / secret redaction** on `query_logs` MCP output: emails, IPv4,
  IPv6 (incl. `::1` / `::ffff:v4`), bearer tokens, JWTs, prefixed
  api-keys. Counts surface in a top-level `_redacted` hint. Opt-out
  via `OMCP_REDACTION=off`. Docs:
  [redaction.md](docs/redaction.md). PR #234.
- **Per-identity rate limit** on the `/mcp` HTTP transport. Default
  60 req/min, configurable via `OMCP_TOOL_RATE_PER_MIN`. Denied
  requests return HTTP 429 with `Retry-After` and a JSON code
  `OMCP_IDENTITY_RATE_LIMIT`. PR #235.
- **Consolidated access-control runbook**
  [docs/access-control.md](docs/access-control.md) — one stop for
  every knob above, a Helm values fragment, and a "who/why"
  investigation runbook. PR #237.

### Added — UI polish (#218–#224)

- **Playwright UI smoke** workflow on every PR — boots the demo stack
  and asserts every primary tab renders without console errors, the
  theme toggle flips, the MCP handshake completes. PR #218.
- **Side rail collapse-to-icon** affordance with native `title`
  tooltips; auto-collapses on viewports narrower than 1100px. PR #223.
- **Sortable tables, live filter inputs, comfortable/compact density
  toggle** on the Sources and Services lists. PR #220.
- **Rich empty states** with icon + title + CTA replacing the bare
  `⌀` glyph; distinguishes loading vs empty. PR #221.
- **Keyboard navigation + zoom toolbar + edge labels** on the topology
  graph. Tab cycles nodes, Enter inspects, Esc clears, arrows move
  focus to the spatially-nearest neighbour. PR #222.
- **Source-form validation + Settings dirty-state save buttons**.
  PR #224.
- **Inline-style purge (first pass)** — 151 → 117 inline `style=`
  attributes consolidated into utility classes. PR #219.

### Added — distribution / docs

- **README hero rewrite** with the cross-namespace blast-radius
  benchmark table above the fold, plus an inline `.mcp.json` snippet.
  PR #225.
- **Honest comparison page**
  [docs/comparison.md](docs/comparison.md) vs Datadog Bits AI,
  HolmesGPT, Robusta — source-cited, no invented numbers. PR #226.
- **Onboarding Make targets** `make connect-claude-code`,
  `make connect-cursor`, `make doctor`. PR #227.
- **Wider npm keywords + GitHub-sponsors funding link + supply-chain
  verification docs** in SECURITY.md. PR #228.

### Changed

- **System font stack everywhere** — dropped the `rsms.me` Inter CDN
  reference; the Web UI renders cleanly behind an air-gap with no
  external network access at all. PR #236.

### Internal

- Sliding-window rate limiter, scrypt password hashing, HMAC-signed
  cookies, canonical-JSON audit chain — all implemented with node
  built-ins, **no new runtime dependencies**.

## [1.4.0] — 2026-05-14

### Added
- **Plugin Loader complete (steps 1–5 of the architecture roadmap)** —
  Prometheus and Loki connectors extracted as filesystem plugins under
  `mcp-server/plugins/`. The PluginLoader scans `PLUGINS_DIR` (default
  `/app/plugins`), validates each `manifest.json` against a Zod schema,
  and falls back to the built-in shim on demand. `PLUGINS_DISABLED`
  short-circuits selected plugins at runtime.
- **OpenAPI 3.1 spec** at `/api/openapi.json` describing the operator
  REST surface (`/api/sources`, `/api/services`, `/api/health`,
  `/api/settings`, `/api/metrics-config`, `/api/info`, `/metrics`).
- **Root-level `/healthz` + `/readyz`** for the k8s convention.
- **`/api/info`** exposes version, build commit/date, plugin inventory,
  and runtime. The Web UI footer renders this live.
- **Web UI enterprise refresh — passes 3 + 4.** Left-aligned stat cards
  with live context sublines (`X/Y connected` color-coded), Overview
  header with live-pulse indicator, inline SVG sparklines on each
  health card (30 samples ≈ 7.5 min at 15s refresh).
- **Helm chart v0.3.0** — `helm test` connection probe, ArtifactHub
  `images` + `changes` annotations, `values.schema.json` validating
  `helm install` input before render, NOTES.txt with post-install
  steps, optional `prometheus.io/scrape` annotations for clusters
  without prometheus-operator.
- **Docker image build args** `GIT_COMMIT` and `BUILD_DATE` baked in via
  Dockerfile ARGs and exposed through `/api/info` build metadata.
- **SBOM (CycloneDX) and SLSA provenance attestations** attached to
  every GHCR image via `docker/build-push-action@v7` (`sbom: true`,
  `provenance: mode=max`).
- **GitHub issue + PR templates** under `.github/` for bug, feature,
  connector-request, and config questions.
- **Path-based PR auto-labeler** with labels server/ui/connector/agent/
  helm/docker/ci/docs/dependencies/security/release.
- **Tool/API/session metrics instrumentation** — `obsmcp_tool_calls_total`,
  `obsmcp_api_requests_total`, `obsmcp_active_sessions`, `obsmcp_connector_calls_total`
  (per connector via a loader decorator).
- **Connector-level metrics** wrapped at the loader's `create()` site
  so connector authors get observability for free.
- **Web UI server-info footer** populated from `/api/info`.
- **`Makefile`** with canonical Docker workflows: `make demo`, `make up`,
  `make test`, `make lint`, `make smoke`, `make release-dryrun`.
- **`docs/airgapped-deployment.md`** — image mirroring, Sigstore
  attestation verification, locked-down NetworkPolicy egress, private
  plugins baked into a derived image, GitOps config.
- **Docker compose `demo` profile** — `docker compose up` runs only
  mcp-server by default; `--profile demo` adds Prometheus, Loki,
  example services and the agent.
- **Repo refactor** — `examples/agent`, `examples/example-services`,
  `examples/prometheus`, `examples/loki`, `examples/promtail`. mcp-server
  is the deliverable, the rest is demo material.
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
- Contact email in SECURITY.md, .artifacthub-repo.yml, and the bug
  issue template corrected to `ai-solutions-camp@email.de`.
- Loki ring init on WSL2/Docker with the upgraded image.
- Mermaid label crash on certain unicode chars in the docs.
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
