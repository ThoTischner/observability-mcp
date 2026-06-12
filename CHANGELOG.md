# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.7.0] — 2026-06-12

Feature release. Additive / non-breaking — the air-gapped default is unchanged.

### Added

- **`enrich_ips` optional online RDAP fallback (#477).** For deployments that
  aren't air-gapped, you can now enable an opt-in online backend that resolves
  IPs via authoritative-registry **RDAP** (RFC 9082/9083) over HTTPS, instead of
  building a MaxMind dataset:
  - **OFF by default** — set `OMCP_IP_ENRICH_RDAP=on` to enable (optionally
    `OMCP_IP_ENRICH_RDAP_URL` to override the default `https://rdap.org`
    bootstrap). No external call is ever made unless you opt in; the
    air-gapped guarantee holds in the default config.
  - **Offline dataset stays preferred.** RDAP is only consulted for IPs the
    local CSV didn't cover (or when no dataset is configured). Hits carry
    `via: "dataset"` / `via: "rdap"`; the summary reports `viaRdap`.
  - **Returns country + org only** — RDAP has no city-level geo or
    hosting/proxy flag (the org name is the bot-vs-human signal). Results are
    cached with a TTL; a flaky RIR returns a miss, never a hard error.
  - The new outbound call is registered in the verifiable-offline egress
    policy as an opt-in destination, so the "no telemetry/phone-home" guard
    still holds.

## [3.6.1] — 2026-06-11

Security + agent-feedback patch. Additive / non-breaking.

### Fixed

- **`enrich_ips` now advertises IPv6 in its MCP tool surface (#476).** IPv6
  lookup shipped in 3.4.0, but the agent-facing `tools/list` description +
  `ips` param (the inline registration in index.ts) still said "IPv4
  addresses" — so an agent would pre-filter IPv6 clients out before calling,
  hiding the capability at its core use case. Both now say "IPv4 or IPv6"
  with a v6 example; a conformance assertion guards the advertised surface.
- **OpenSSL base-image CVEs cleared.** The pinned `node:26-alpine` digest
  carried `libcrypto3`/`libssl3` 3.5.6-r0 (a batch of OpenSSL CVEs flagged by
  the Trivy image scan); the runtime stage now `apk upgrade`s just those two
  packages to 3.5.7-r0 at build time.

### Security

- Triaged the 14 open CodeQL alerts on our code: all were verified
  false-positive / won't-fix / used-in-tests and dismissed with written
  justifications — the code already carried the relevant guards (a
  `__proto__`/`constructor`/`prototype` deny-set + allow-lists on the
  batch-dry-run matrix, `sanitizeForLog` on logged user input, an operator-
  config-only fs path, and linear/anchored regexes on trusted input). No
  code change was required; this is recorded for auditability.

### Notes

- The SDK (`@thotischner/observability-mcp-sdk`) is unchanged.

## [3.6.0] — 2026-06-11

Closes the **last** open v3.3 candidate — the SCIM Provisioning UI.
Additive / opt-in; migrating from 3.5 is non-breaking.

### Added

- **SCIM Provisioning dashboard sub-tab + `GET /api/provisioning`.** A
  read-only view (under Access → Provisioning) of the Users and Groups an
  identity provider has pushed via SCIM 2.0, so operators can confirm a
  sync without poking the token-gated `/scim/v2` API from a browser. The
  endpoint is admin-gated (`users:delete`, like `/api/subjects`) and its
  projection is **secret-free** — userName/displayName/active/groups for
  users and displayName/member-count for groups; the SCIM token, password,
  raw meta/schemas and emails are never returned. When SCIM is not enabled
  it returns `configured:false` with a "how to enable" note (not a 404),
  and the UI renders that state; the tables have a client-side filter.

### Notes

- This completes the v3.3 candidate set — the candidate list is now empty.
- The SDK (`@thotischner/observability-mcp-sdk`) is unchanged — a
  gateway-surface + UI addition; the plugin contract did not move.

## [3.5.0] — 2026-06-11

Candidate-cleanup release — closes the remaining v3.3 candidates. All
additive / opt-in; migrating from 3.4 is non-breaking.

### Added

- **SCIM filter + pagination on the collection endpoints** (v3.3
  candidate). `GET /scim/v2/Users` and `/Groups` now support the SCIM
  `filter` query param (`<attr> eq "value"`, plus `active eq true`) and
  `startIndex`/`count` pagination (RFC 7644 §3.4.2) — Okta requires
  `filter` for reconciliation and large directories need paging. A non-`eq`
  / malformed filter returns **400** rather than a misleading full list;
  `ServiceProviderConfig` now advertises `filter.supported: true`. The
  no-param list response is unchanged (back-compat).
- **Custom post-mortem template engine** (v3.3 candidate).
  `generate_postmortem`'s markdown layout is overridable via
  `OMCP_POSTMORTEM_TEMPLATE` (a file of `{{token}}` placeholders:
  service/window/from/to/tenant/synopsis/timeline/blastRadius/signals/
  traces/logHighlights/followUps). Unset → the built-in layout, unchanged.
  An unknown token is left verbatim; an unreadable template path falls back
  to the built-in layout (logged), never failing the report. See
  [postmortems.md](docs/postmortems.md#custom-report-template).

### Changed

- ROADMAP reconciled again: the strict-mode MkDocs build was already
  shipping (`docs.yml` runs `mkdocs build --strict`), so it was dropped
  from the candidate list.

### Notes

- The SCIM **Provisioning UI sub-tab** half of that candidate is
  intentionally deferred — identity providers reconcile directly against
  `/scim/v2`, so the dashboard view is lower-value; it remains the one open
  v3.3 candidate.
- The SDK (`@thotischner/observability-mcp-sdk`) is unchanged — these are
  gateway-surface and tooling changes; the plugin contract did not move.

## [3.4.0] — 2026-06-11

Roadmap-candidate release — closes two v3.3 candidates and proactively
hardens the remaining tools against the "absent ≠ zero" empty-state class
(the root of #453/#462) before it could be reported again. All additive /
opt-in; migrating from 3.3 is non-breaking.

### Added

- **IPv6 in `enrich_ips` + an offline dataset converter** (v3.3 candidate).
  `enrich_ips` now resolves IPv6 as well as IPv4 (128-bit longest-prefix
  lookup, `::` compression and IPv4-mapped tails parse); v6 rows in the
  dataset are loaded, not skipped, and the tool accepts v6 inputs.
  `scripts/build-ip-enrich-csv.mjs` reshapes a licensed **MaxMind
  GeoLite2** export (City + Locations + optional ASN, v4 + v6) into the
  `enrich_ips` CSV — dependency-free, RFC-4180-aware. The geo/ASN data
  stays operator-side; nothing is bundled and there is no network call,
  preserving the air-gapped guarantee. See [ip-enrichment.md](docs/ip-enrichment.md).
- **Per-credential `raw_query` gating** (v3.3 candidate). `raw_query` was a
  global-only capability (`OMCP_RAW_QUERY=on`); a credential can now be
  granted it individually via `OMCP_KEY_RAW_QUERY="agent,ci"` (credential
  names, mirroring `OMCP_KEY_BYPASS_REDACTION`). Effective gate is
  `global OR per-credential` — it only widens, never narrows a
  globally-enabled deployment. See [raw-query.md](docs/raw-query.md).

### Fixed

- **Honest no-data / partial states across the remaining tools** (proactive
  sweep of the #453/#462 class):
  - `list_services` distinguishes *no backends configured* / *discovery
    failed on all sources* / *genuinely none* via a `note`, and surfaces
    `partial:true` + `failedSources[]` when only some sources fail
    (previously a down source silently halved the fleet).
  - `list_sources` adds an explanatory `note` when nothing is configured.
  - `get_blast_radius` returns an explicit "no topology connector" note
    when no topology source is configured, instead of a generic
    "resource not found" that misattributed the cause.
  - `generate_postmortem` computes `coverage{anomalies,traces,topology,logs}`
    + `builtFromSignal` and leads the markdown with a banner when the report
    was built from zero signal — so it isn't mistaken for a real finding.

### Changed

- **ROADMAP reconciled** against shipped state — the stale `Next`/`Later`
  vision lists (and a duplicate `v3.0 — next` block) had items that already
  shipped (verifiable offline, query_traces, plugin SDK on npm, multi-tenant,
  auto-postmortems, embeddable analysis library); these moved to the landed
  sections. A dead internal anchor and two links to a private directory were
  removed.
- The `hash-password` policy-sync test no longer emits a spurious failure
  under the docker-first partial mount — it skips when the repo-root script
  is unreachable, but still asserts in CI (full checkout).

### Notes

- `MetricResult.summary`/`MetricGroup.summary` have been nullable since
  3.3.2 (the #462 no-data fix); no further type change here.
- The SDK (`@thotischner/observability-mcp-sdk`) is unchanged — these are
  gateway tool-surface and tooling changes; the plugin contract did not move.

## [3.3.2] — 2026-06-11

Agent-feedback patch — two more reports against 3.3.1 (#462 and the
reopened #452) extending the "absent ≠ zero" honesty principle into the
raw metric tool and tidying a stale field the fail-fast fix surfaced.
Additive and non-breaking.

### Fixed

- **`query_metrics` reports no-data honestly instead of false zeros
  (#462).** For a service with no matching series (e.g. a logs-only
  service queried for `cpu`), the tool returned `values:[]` but
  `summary:{current:0,…,trend:"stable"}` — indistinguishable from a
  service genuinely idling at 0. `summary` is now `null` (with an
  explanatory `note`) when no series matched, mirroring the #453A health
  fix one level down. `MetricResult.summary` and `MetricGroup.summary`
  are now nullable; consumers (correlation, health scoring) treat a null
  summary as no-data.
- **`query_logs` error responses report `window`, not `duration`
  (#452).** The fail-fast fix (3.3.1) surfaced a stale field: the
  error / no-data response echoed the requested look-back as `duration`,
  which an agent reads as elapsed wall-clock — so a sub-second failure
  looked like a 5-minute hang. The field is now named `window`; the
  success path and the input parameter are unchanged.

### Notes

- The label-filtered `count_over_time` 400 reported under #452 could not
  be reproduced: the emitted LogQL
  (`sum (count_over_time({sel} | json | label="v" [step]))`) is
  well-formed and structurally identical to the working `sum`/`topk`
  path. A regression guard asserting that LogQL shape was added; the
  intermittent 400 is treated as backend-side/transient.
- `MetricResult.summary`/`MetricGroup.summary` becoming nullable is
  additive (a new `null` case for the no-data state); existing readers
  that always had data are unaffected. SDK unchanged.

## [3.3.1] — 2026-06-10

Agent-feedback patch — three structured agent reports against 3.3.0
(#452/#453/#455, Loki + Grafana Cloud) turned up two real `query_logs`
bugs, a "false-healthy" gap in the health tooling, and the missing
auto-injected usage channel. Every finding was adversarially verified
and fixed over the real MCP transport. Additive and non-breaking.

### Fixed

- **`query_logs` `aggregate: count_over_time` no longer leaks the label
  set (#452).** With an empty `by`, a bucketed `count_over_time` over a
  `| json` stream kept every extracted label (rid/ip/status/…) as its
  own series, so "requests over time" came back as a high-cardinality
  mess instead of one bucketed total. It is now always `sum`-wrapped —
  no `by` collapses to a single series; explicit `by` is unchanged.
- **`query_logs` `raw_query` with a vector/matrix aggregation fails fast
  with a clear message instead of crashing (#452).** A metric
  `raw_query` (e.g. `sum(count_over_time(...))`) returns Loki resultType
  vector/matrix, not streams; the streams parser dereferenced undefined
  fields and crashed on `.level`, and the 5-minute default window meant
  it ran to timeout. The handler now checks `resultType` and returns an
  actionable error ("use `aggregate` for counts/top-k, or query_metrics
  raw_query for vector/matrix results").
- **`get_service_health` reports honest "no data" / "not found" instead
  of a confident `100/healthy` (#453).** Absent metrics were coerced to
  `0` and scored as healthy — even for a log-only service with no metric
  coverage, and even for a service that does not exist (a typo read as
  good news). Health is now computed only over the signal families that
  actually returned data (`coverage:{metrics,logs}`); a service with no
  data in any signal is `status:"unknown"`, `score:null`, and an unknown
  name yields an explicit "not found" note like the other tools'
  empty-states. `signals.metrics`/`signals.logs` are `null` when absent.
- **`detect_anomalies` fleet scan no longer silently drops log-only
  services (#453).** Service discovery enumerated only metrics
  connectors, so a log-only service was skipped and the "all healthy"
  all-clear was misleadingly partial. Discovery now unions metrics + log
  connectors (log-only services are scanned via their log error-rate),
  and the result carries `coverage.scanned:[{service,signals[]}]` plus a
  summary that states the coverage, so an all-clear is verifiable.

### Added

- **`initialize.instructions` is now populated (#455).** The one channel
  the MCP spec auto-injects into an agent's context on connect was empty,
  so the 3.3.0 usage guide only reached agents a human pointed at it. It
  now carries a tight kernel: read `omcp://guide/agent-usage`, the
  filter+aggregate golden rule, all-tools-read-only, the
  empty-states-name-the-flag contract, and a pointer to the agent-report
  template. The golden rule is also seeded into the `query_logs`
  description as a fallback for clients that don't surface instructions.
- **Collaboration pointers aligned (#455 follow-up).** The
  `omcp://guide/agent-usage` resource's Report-findings section gains the
  Discussions link (with an operator-behalf caveat) so the guide and
  `/llms.txt` agree — the Discussions link stays out of the per-connect
  `instructions` kernel by design.

### Notes

- **Behaviour change for custom health weights that don't sum to 1.0:**
  `calculateHealthScore` now renormalises by the active signal weights.
  With the default weights (which sum to 1.0) the score is unchanged;
  custom thresholds whose weights don't sum to 1.0 will shift slightly
  (the renormalised value is more correct — the old path could exceed
  100 before clamping).
- The SDK (`@thotischner/observability-mcp-sdk`) is unchanged — these are
  all gateway tool-surface fixes; the plugin contract did not move.

## [3.3.0] — 2026-06-10

Agent-experience release — the gateway's primary audience is an LLM
agent, so this release makes the MCP surface self-describing and the
collaboration loop a paved road. Purely additive; no migration needed.

### Added

- **MCP ToolAnnotations on all 12 tools** — every builtin tool now
  advertises `{title, readOnlyHint: true, destructiveHint: false,
  idempotentHint: true, openWorldHint: false}` over `tools/list`.
  Clients (e.g. Claude) use these hints for auto-approve decisions;
  the whole surface is read-only and now says so machine-readably.
- **Builtin MCP resources + prompts** (first registrations through the
  Q12 hook-wrapped seams, so plugin resource/prompt hooks now fire):
  - resource **`omcp://guide/agent-usage`** (text/markdown) — the
    agent-validated #415 workflow: filter→aggregate→enrich recipe,
    signal-vs-silence behaviours, operator flags, report link.
  - prompt **`triage-incident`** (service) — composes
    `get_service_health` → `detect_anomalies` → `get_blast_radius` →
    aggregated `query_logs`.
  - prompt **`write-postmortem`** (service, duration?) —
    `generate_postmortem` + verification + blameless-rewrite steps.
- **`GET /llms.txt`** — the llms.txt convention, generated at boot from
  the canonical tool registry (can't drift from the real surface), plus
  a static variant at the docs-site root. Public in all auth modes.
- **Official MCP Registry presence** — `server.json` + an OIDC publish
  workflow (`mcp-registry-publish.yml`, runs on every release tag);
  listed as `io.github.ThoTischner/observability-mcp`.
- **Agent collaboration scaffolding** — `docs/for-agents.md` (connect,
  proven triage recipe, how to report), the `agent-report` issue form
  encoding the #415 report format, and seeded GitHub Discussions
  (release announcements + the #415 case study).

### Changed

- README hero: benchmark headline (0/10 → 10/10) + 30-second connect
  snippet now sit above the badge wall; secondary badges folded.

### Notes

- The SDK (`@thotischner/observability-mcp-sdk`) is unchanged (3.2.1) —
  the plugin contract did not move.
- All of the above is verified live over the MCP transport and pinned
  by conformance tests in CI (tools/list annotations, resources/read,
  prompts/get, /llms.txt).

## [3.2.1] — 2026-06-10

Hardening patch — a post-3.2.0 reachability / end-to-end audit (4 gap
classes: MCP reachability, wired-but-dead, stale docs, real-E2E-vs-unit)
turned up one real bug and a set of doc/coverage gaps. Every finding was
adversarially verified before fixing.

### Fixed

- **`get_anomaly_history` returns data again.** The handler built a
  complete PromQL selector (`omcp_anomaly_score{service=…,method=…}`)
  but passed it as the `metric` arg; the curated path wrapped it into
  invalid double-brace PromQL (`…{…}{ job=… }`) → Prometheus 400 → the
  catch swallowed it and the tool **always** reported "no history". It
  could never return data via a Prometheus source. Now routed verbatim
  via `rawQuery`. Regression-tested.

### Changed

- **Builtin connector manifests now advertise their real capabilities**
  (the Connectors UI renders these): Loki adds `queryLogAggregate`;
  Kubernetes adds its topology-provider capabilities
  (`listServices`/`listResources`/`listEdges`/`getTopologySnapshot`/
  `watchTopology`). The manifest `capabilities` schema (and the
  published SDK mirror) gained the corresponding optional keys.
- **`list_services` now surfaces per-service `labels`** (e.g. the Loki
  connector's `discoveredVia`) — the value was computed then dropped in
  the dedup merge, so `docs/loki.md`'s documented field never appeared.
- Documentation/description corrections found by the audit: `list_sources`
  no longer promises a `url` field it never returned; `query_traces`
  comments/description no longer imply a bundled Tempo/Jaeger plugin
  (Tempo installs from the hub; no Jaeger connector exists);
  `postmortems.md` documents the shipped persistence endpoints;
  `anomaly-history.md` reflects that the detector→history hook is wired.

### Testing (CI-persisted, post-#415)

- **Real `tools/call` behavioural E2E over the live MCP transport**
  (runs in `integration.yml`) — asserts curated params *take effect over
  the wire* (raw_query gate, `query_logs` aggregate shape, `enrich_ips`,
  per-tool dispatch for all 12), closing the class of gap that let the
  3.1.0 `labels`/`aggregate` ship unreachable.
- **Playwright coverage** for previously-uncovered tabs
  (postmortems/audit/entitlement) and the Add-Source test-connection +
  URL-validation flow (`ui-smoke`).

### Notes

- The SDK (`@thotischner/observability-mcp-sdk`) bumps to 3.2.1 — its
  published `manifestSchema` gained the new optional capability keys.

## [3.2.0] — 2026-06-09

Agent-usability release — closes the remaining points from the
real-world feedback in issue #415 (the log-side #1/#2 shipped in 3.1.x).
Every addition is opt-in or additive; migrating from 3.1 is
non-breaking. See [`docs/migrations/3.1-to-3.2.md`](docs/migrations/3.1-to-3.2.md).

### Added

- **`query_metrics` `labels` filter** (issue #415 #4) — an optional
  exact-match label map AND'd into the metric's PromQL series selector,
  the metrics-side equivalent of the `query_logs` `labels` param. Scope
  a curated metric to a subset of series (e.g. `error_rate` for one
  `route`/`status`) instead of the all-series aggregate; combine with
  `groupBy` to filter-then-break-down. Label names re-validated and
  values escaped for PromQL (backslash/quote/`\n\r\t`).
- **`raw_query` passthrough** (issue #415 #3) — an escape hatch for
  verbatim PromQL (`query_metrics`) and LogQL (`query_logs`) when the
  curated catalog can't express a query. **Capability-gated, OFF by
  default**: enable with `OMCP_RAW_QUERY=on`. Still tenant-scoped,
  source-allow-listed, and (for logs) redacted; mutually exclusive with
  `aggregate`. The param is advertised even when disabled so an agent
  can discover and explain the requirement. See
  [raw-query.md](docs/raw-query.md).
- **`enrich_ips` tool** (issue #415 Gap B) — resolves a batch of IPv4
  addresses to geo (country/city), ASN/org, and a hosting/proxy flag
  from a **local offline dataset** (`OMCP_IP_ENRICH_FILE`, a CSV). No
  per-IP external API call, so it preserves the air-gapped guarantee;
  returns a clear "not configured" notice until a dataset is set. See
  [ip-enrichment.md](docs/ip-enrichment.md).
- **Anonymous-friendly redaction bypass** (issue #415 Gap A) —
  `OMCP_BYPASS_REDACTION_ANON=true` opts the anonymous/stdio identity
  into the per-call `bypass_redaction` arg. In an anonymous deployment
  there is no named credential to add to `OMCP_KEY_BYPASS_REDACTION`, so
  this is the only way a single-user self-hosted agent can see raw
  values on its own logs without the blunt global `OMCP_REDACTION=off`.
  Default OFF; redaction stays on for every call that doesn't ask, and
  bypasses are audited. See [redaction.md](docs/redaction.md#opt-out).

### Changed

- **`get_topology`** now returns an explicit `note` when no
  topology-capable connector is configured, instead of a bare empty
  graph — signal vs. silence for agents on a Prometheus/Loki-only stack
  (issue #415). Existing fields are unchanged.

### Notes

- The SDK (`@thotischner/observability-mcp-sdk`) is unchanged in 3.2.0
  and stays at 3.1.0 — these are all gateway tool-surface changes; the
  plugin contract / manifest `schemaVersion` did not move.

## [3.1.1] — 2026-06-09

Patch release — fixes a ship gap in 3.1.0 reported from real-world use
(issue #415).

### Fixed

- **`query_logs` `labels` and `aggregate` params are now reachable over
  MCP.** In 3.1.0 the handler and connector code for structured label
  filters (#1) and server-side aggregation (#2) shipped, but the inline
  MCP input schema in the tool registration never advertised the two
  params — so the MCP SDK stripped them from incoming calls before they
  reached the handler. A `tools/list` handshake omitted them and passing
  them was a silent no-op (raw, unfiltered rows returned). The
  registration now declares both, so `labels` / `aggregate` work over
  MCP exactly as documented in [loki.md](docs/loki.md). No API change —
  this only makes the already-documented 3.1.0 surface actually
  callable. A conformance assertion (live `tools/list`) plus a static
  registration guard now prevent this class of regression.

## [3.1.0] — 2026-06-08

Incremental release — the **Phase Q sprint** closes the
"Deferred to v3.x" backlog from 3.0. Every item is opt-in via env /
Helm value; migrating from 3.0 is **purely additive** (3.0.1 was a
republish-only version bump with no behaviour change). See
[`docs/migrations/3.0-to-3.1.md`](docs/migrations/3.0-to-3.1.md).

### Added — topology providers

Five concrete providers on the F14a multi-cloud merger foundation.
Each ships as a filesystem connector (lazy-loaded SDK, manifest
integrity + hub catalog entry) and merges into the unified topology
graph so a single service collapses across providers.

- **AWS** (`connectors/aws/`) — EC2 instances, ECS services/tasks,
  EKS clusters/nodepools → `cloud_service` / `cloud_node` resources
  with `OWNED_BY` / `RUNS_ON` edges. Standard AWS SDK credential
  chain.
- **GCP** (`connectors/gcp/`) — GKE clusters/nodepools, Cloud Run
  services, Compute Engine instances.
- **Istio** (`connectors/istio/`) — `CALLS` edges derived from
  `istio_requests_total` in the mesh's Prometheus.
- **Linkerd** (`connectors/linkerd/`) — `CALLS` edges from the viz
  `response_total` series.
- **Consul** (`connectors/consul/`) — Consul Connect service graph
  via the catalog + health HTTP API.

### Added — federation transports

- **Stdio upstream** — federate an upstream MCP server spawned as a
  child process (`name=stdio:<command>`).
- **WebSocket upstream** — federate over the WS transport
  (`name=ws://host/mcp/ws`). Both share the existing
  `UpstreamClient` interface and the federation E2E harness.

### Added — plugin / hook system

- **Manifest-driven hook auto-registration** — `manifest.hooks[]`
  entries register into the `HookRegistry` at load; plugins no
  longer need programmatic wiring.
- **Resource + prompt hooks at the MCP seam** —
  `resource_pre_fetch` / `resource_post_fetch` / `prompt_pre_fetch`
  / `prompt_post_fetch` now fire around `resources/read` and
  `prompts/get`, mirroring the tool hooks.

### Added — provisioning (SCIM 2.0)

- **Redis-backed SCIM store** — `OMCP_SCIM_BACKEND=redis` shares a
  single snapshot across replicas (file remains the default).
- **PATCH add/remove on `members[]` + `emails[]`**, including the
  `members[value eq "x"]` filter path Entra/Okta emit.
- **Full SCIM 2.0 compliance suite** (`scim/compliance.test.ts`,
  env-gated) — discovery, the 401 gate, the User+Group lifecycle,
  409/404 with the SCIM error schema. Surfaced + fixed two
  production wiring bugs (`application/scim+json` body parsing; the
  Redis backend not reaching prod).

### Added — operability

- **S3-compatible audit sink** — per-minute JSONL rollups to
  S3 / MinIO / R2 / B2 (`audit.s3.*`).
- **Redis-backed transport session map** — multi-replica gateways
  no longer need sticky ingress for Streamable HTTP sessions.
- **In-product Playground tab** — pick a live tool, render its
  input schema as a form, invoke, and view a pretty / table / raw
  response. Backed by `POST /api/playground/invoke`.
- **Health-tab anomaly sparkline** — each card shows the last hour
  of `omcp_anomaly_score` from an in-process ring on the
  `AnomalyHistory` sink (`GET /api/health/anomaly-sparklines`); no
  TSDB round-trip required.

### Added — agent log analytics (issue #415)

- **`query_logs` structured label filters** — a `labels` map of
  exact-match filters (method/status/url/ip/environment, …), AND'd
  together, compiled to LogQL label filters after `| json`. Far more
  reliable than regex on structured JSON logs, where `GET /` never
  appears verbatim. `environment` filtering falls out for free. Log
  `level` is now also derived from HTTP status (5xx→error, 4xx→warn)
  when no explicit level field exists.
- **`query_logs` server-side aggregation** — an `aggregate`
  ({op: count_over_time|sum|topk, by, k, step}) that pushes counting
  down to LogQL metric queries, so an agent gets a number (top paths,
  per-status totals, a count time series) instead of pulling raw rows
  and hitting `limit`.

### Added — security hardening

- **Session revocation blocklist** — `POST /api/auth/revocations`
  revokes a single session (`sid`) or every session for a subject;
  checked on each request. On-disk JSONL
  (`OMCP_AUTH_REVOCATION_FILE`).
- **Per-account login lockout** — failed-login counter with
  progressive backoff, on top of the per-IP rate limit; backed by
  the shared session store. `OMCP_AUTH_LOCKOUT_*`.
- **Password policy** for basic-auth credential minting — length /
  character-class / common-password-denylist checks in
  `hash-password.mjs`. `OMCP_PASSWORD_*`.
- **Content-Security-Policy** for the Web UI — an enforced
  lockdown policy (`default-src 'self'`, `object-src 'none'`, …)
  plus per-request nonces and an opt-in strict report-only policy
  (`OMCP_CSP_STRICT_REPORT`) that reports to `/api/csp-violations`.

### Added — post-3.0 increments (first released here)

These landed on `main` shortly after the 3.0.0 tag but were never cut
into a release (3.0.1 was republish-only), so they ship to users for
the first time in 3.1.0:

- **Policies "Batch evaluate" panel** — a Policies-tab sub-view over
  the existing `POST /api/policy/dry-run-batch` API (matrix / CSV).
- **Postmortems persistence + UI tab** — `/api/postmortems` now
  persists (`OMCP_POSTMORTEMS_FILE`) and a Postmortems nav page
  lists + renders generated reports. (A custom template engine
  remains future work.)

### Changed — tooling

- **SDK source-sync tooling** (`make sdk-sync` / `make sdk-parity`)
  replaces hand-maintenance of the vendored SDK copy; a CI parity
  gate prevents drift.

### Backwards compatibility

Every 3.1 capability is opt-in via env or Helm value. The default
single-replica anonymous-auth demo runs identically on 3.0 and 3.1.

## [3.0.1] — 2026-06-08

Republish-only version bump (Helm chart + npm) to resolve an
ArtifactHub image-scan mismatch. No code or behaviour changes.

## [3.0.0] — 2026-06-06

Major release. v3.0 is the **moat-extension sprint** on top of the
v2.0 foundation: more MCP tools, more provider depth, more
operator visibility, and a CI proof of the air-gapped story.

Migrating from 2.x is **purely additive** — every new capability
is opt-in via env / Helm value. See
[`docs/migrations/2.x-to-3.0.md`](docs/migrations/2.x-to-3.0.md).

### Added — new MCP tools

- **`query_traces(service, duration, filter?, limit?, errorsOnly?)`** —
  ninth MCP tool. Fans out across every connector implementing the
  new `queryTraces` capability (Tempo / Jaeger). Returns ranked
  trace summaries with a globally-recomputed p50/p95 over the
  merged set. Closes the metrics/logs/**traces** triangle.
- **`get_anomaly_history(service, duration, method?)`** — tenth
  tool. Replays historical anomaly scores written to the TSDB by
  the new `AnomalyHistory` sink. Default off; opt-in via
  `OMCP_ANOMALY_HISTORY_REMOTE_WRITE`. Powers the auto-postmortem
  feature below.
- **`generate_postmortem(service, duration, format?)`** — eleventh
  tool. Stitches the gateway's existing primitives — anomaly
  history, trace summaries, topology blast-radius, log highlights —
  into a single markdown report a human or LLM reads in one shot.

### Added — capabilities

- **Multi-cloud topology foundation** — new merger module
  collapses Resources that come from multiple providers (k8s
  Deployment + ECS service + Tempo trace_service for the same
  logical workload) into one canonical node via explicit
  `canonicalName` override / `CANONICAL_LABEL_KEYS` match /
  kind-compatibility table. 8 new reserved kinds in the topology
  vocabulary. Concrete cloud-provider connectors land as
  filesystem plugins in v3.x increments.
- **Anomaly history TSDB sink** — every chained anomaly score
  mirrored to a Prometheus remote-write endpoint via the new
  `AnomalyHistory` writer. JSON-shaped WriteRequest payload (any
  TSDB-receiving collector ingests it).
- **Batch policy dry-run** — `POST /api/policy/dry-run-batch`
  evaluates every (subject × resource × action) cell against the
  active engine and returns a matrix the UI heat-map will render.
  CSV export via `Accept: text/csv`.
- **MkDocs Material documentation site** at
  <https://thotischner.github.io/observability-mcp/>. Every push to
  main republishes.
- **MCP Inspector quickstart** — new `omcp inspector-config`
  subcommand emits a config the official Inspector consumes in
  one line. Opens the gateway in an interactive explorer with
  zero handwritten config.
- **SCIM 2.0 Users + Groups provisioning** — Microsoft Entra ID
  and Okta push directory state into `/scim/v2/*` directly. Bearer
  auth via `OMCP_SCIM_TOKEN`. Group→role mapping via
  `OMCP_SCIM_GROUP_ROLE_MAP`.
- **Plugin SDK published as `@thotischner/observability-mcp-sdk`** —
  standalone npm package plugin authors depend on without cloning
  the gateway. Scaffolder CLI:
  `npx @thotischner/observability-mcp-sdk create-connector my-conn`.

### Added — operator surface

- **Verifiable-offline CI** — new `.github/workflows/airgapped.yml`
  boots the demo stack with iptables egress blocked on the
  mcp-server container, then asserts /healthz, no-CDN-in-UI, MCP
  handshake, and a tool call all work. Future regression that
  adds a phone-home / CDN font / telemetry beacon fails at PR
  time.
- **Helm `airgapped: true`** value renders an egress-deny
  NetworkPolicy (allow DNS + same-namespace + operator allowlist)
  and sets `OMCP_AIRGAPPED=true` in the container env.

### Deferred to v3.x (incremental)

> Most of this list shipped in **3.1.0** (the Phase Q sprint) — see
> that section above. The items below remain open after 3.1:

- F17b strict-mode mkdocs build (clean up the cross-repo links
  flagged as warnings).
- A custom postmortem template engine (F19c — persistence and the
  Postmortems UI tab already shipped; today templates are built-in).
- SCIM filter/search on the collection endpoints + a UI
  Provisioning sub-tab (F21 — push-only Entra+Okta provisioning
  works today; PATCH add/remove, the Redis store, and the full
  compliance suite all shipped in 3.1).

### Backwards compatibility

Every v3.0 capability is opt-in via env or Helm value. The
default single-replica anonymous-auth Docker-compose demo runs
identically on 2.x and 3.0. No behaviour flips required.

## [2.0.0] — 2026-06-06

Major release. v2.0 closes the remaining adoption-blocking gaps so a
single deployment of observability-mcp is a complete MCP control
plane: federate other MCP servers under one endpoint, multi-replica
HA, WebSocket transport, OIDC vendor presets for every major IdP,
plugin lifecycle hooks, hardened web-app baseline, and provable
MCP-spec conformance.

Migrating from 1.x is additive — every new behaviour is opt-in via
env / Helm values. See [`docs/migrations/1.x-to-2.0.md`](docs/migrations/1.x-to-2.0.md).

### Added — capabilities

- **Upstream MCP federation** — `OMCP_FEDERATION_UPSTREAMS=name=url,…`
  proxies every upstream's tools under a stable `<name>.<tool>`
  namespace on the local `/mcp`. Federated tools dispatch through
  the same `registerTool` wrapper as native ones, so per-credential
  allow-lists, lifecycle hooks, audit, and rate-limit apply
  uniformly. Static-bearer auth per source via
  `OMCP_FEDERATION_TOKEN_<NAME>`. Docs: [`docs/federation.md`](docs/federation.md).
- **Virtual MCP servers** — every published Product gets its own
  Streamable HTTP endpoint at `/mcp/v/<product-id>` that exposes
  ONLY the tools bound to that Product. Sessions are bound to the
  product they were issued under; cross-product probes return 404.
  Backwards compat: root `/mcp` still serves the full surface.
- **WebSocket MCP transport** at `ws://host:3000/mcp/ws`. Bearer
  token accepted from `Authorization`, `?token=`, or
  `Sec-WebSocket-Protocol: bearer.X` (precedence in that order).
  Heartbeat ping every 30s, close 1001 after 90s of no pong. Docs:
  [`docs/transports.md`](docs/transports.md).
- **MCP 2025-11-25 conformance harness** — 10-test suite over a
  running gateway runs via `make conformance` and as a required CI
  check; `GET /api/conformance` returns the supported revisions /
  transports / methods for procurement probes. Docs:
  [`docs/mcp-conformance.md`](docs/mcp-conformance.md).
- **SSO vendor profiles** — `OMCP_OIDC_PROFILE=generic|keycloak|github|google|microsoft-entra|okta`
  preconfigures the IdP-shaped fields (scopes / rolesClaim /
  tenantClaim). Explicit `OMCP_OIDC_*` env vars always win. Per-vendor
  setup guides under [`docs/auth-oidc-providers/`](docs/auth-oidc-providers/).
- **RFC 7591 Dynamic Client Registration** at
  `POST /api/auth/oidc/register` (opt-in via
  `OMCP_OIDC_DCR_ENABLED=true`). Validates redirect_uris (https only
  except localhost), mints UUID `client_id` + base64url secret
  (omitted for `auth_method=none`), persists to JSON at
  `OMCP_OIDC_DCR_STORE` (mode 0600, atomic tmp+rename). Rate-limited
  per source IP at 10/hour.
- **Plugin lifecycle hooks** — manifest `hooks[]` block + new
  `HookRegistry` fires `tool_pre_invoke` / `tool_post_invoke` (plus
  resource_*/prompt_* seams in follow-up) around every tool dispatch.
  Hooks can deny the call, mutate the args, or mutate the result.
  Example plugin `plugins/redact-pii/` masks emails and IPv4 in tool
  results. SDK exports `HookRegistry`, `HookKind`, `HookContext`,
  `HookPayload`, `HookResult`, `HookRegistration`.
- **Pluggable audit sinks** — `OMCP_AUDIT_WEBHOOK_URL` fans every
  chained audit entry out to an external HTTP receiver (Splunk HEC,
  SIEM ingestor) with retries + exponential backoff + on-disk DLQ.
  On-disk JSONL master remains the authoritative chain. Docs:
  [`docs/audit-sinks.md`](docs/audit-sinks.md).
- **OpenTelemetry self-tracing** — `OMCP_OTEL_ENABLED=true`
  + `OMCP_OTEL_ENDPOINT` exports every `/api/*` and `/mcp` request as
  a span via OTLP/HTTP. Resource attrs: `service.name` /
  `service.version` / `service.instance.id`. Connector HTTP calls
  surface as child spans so one trace covers the full caller →
  backend chain. Docs: [`docs/self-observability.md`](docs/self-observability.md).
- **Shared session store** — `OMCP_REDIS_URL` opts every replica
  into a shared Redis-backed store for sessions / OIDC flow / DCR /
  federation cache. Default in-memory store preserves the pre-2.0
  single-replica behaviour exactly. Helm chart renders a
  `PodDisruptionBudget` (minAvailable 1) when `replicaCount > 1`.
  Sticky-ingress annotations (`ingressSticky.enabled`) as a fallback
  for deployments that can't run Redis. Docs:
  [`docs/horizontal-scaling.md`](docs/horizontal-scaling.md).

### Added — security

- **CSRF double-submit cookie** on every mutating `/api/*` request.
  Bearer / X-API-Key clients bypass by default
  (`OMCP_CSRF_BYPASS_BEARER=true`) — they can't be a browser
  confused-deputy and CI/agents/MCP clients keep working.
- **SSRF strict-mode** on operator-supplied connector URLs. Rejects
  cloud-metadata IPs (always), RFC1918 + loopback + link-local IPv4,
  IPv6 loopback / ULA / link-local. Opt-out for in-cluster backends
  via `OMCP_ALLOW_PRIVATE_BACKENDS=true`.
- **Plugin signature verification default ON** — `VERIFY_PLUGINS=true`
  is now the default. Operators who run unsigned filesystem plugins
  must opt out with `VERIFY_PLUGINS=false`. Builtin connectors stay
  always-loadable (part of the trusted image), so the demo and any
  deployment without `/app/plugins` is unaffected. Docs:
  [`docs/plugin-architecture.md`](docs/plugin-architecture.md).

### Deferred to v2.x (incremental)

- Resource / prompt hook seams + manifest-driven loader that auto-
  registers from disk (the F7 foundation ships; existing consumers
  register programmatically).
- Stdio + WebSocket federation upstream transports, caller-OIDC /
  UAID passthrough auth, `/api/federation` runtime management,
  `sources.yaml` federation schema, UI add-modal.
- Redis migration of in-memory MCP transport map + OIDC flow state +
  DCR registrations (the F8 SessionStore is ready; F10 is the first
  consumer).
- S3-compatible audit sink (the F4 plugin-sink architecture is in
  place; webhook is the first concrete sink).
- JWT revocation blocklist, account lockout for local accounts,
  configurable password policy, CSP nonces with `report-to`,
  rate-limit headers on `/api/*`, `@requirePermission` completeness
  audit pass (F11b).

### Backwards compatibility

Every new capability above is opt-in via env / Helm value. The
default single-replica anonymous-auth Docker-compose demo runs
identically on 1.8.x and 2.0.0. The one behaviour flip is plugin
signature verification — see migration guide for the opt-out path.


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
- **"Load more" button** on the Web UI's Management changes audit
  table — bumps the page size from the default 50 to the in-memory
  ring cap (500) without curl-ing the API. #248
- **`verify-audit.mjs --quiet`** flag for unattended cron monitoring —
  silent on a healthy chain, still loud + JSON-on-stdout on a break.
  `docs/access-control.md` ships a sample cron line. #249
- **Hot-reload of `OMCP_USERS_FILE`** on the next login attempt —
  edit the users file at runtime, the change takes effect for the
  very next sign-in. One info log line per actual reload; transient
  read errors keep the cached set so logins continue uninterrupted. #250
- **`X-RateLimit-Limit / Remaining / Window-Ms`** headers on every
  `/mcp` response — well-behaved clients can self-pace before hitting
  a 429. #252
- **Colour-coded HTTP status pills** in the Management changes audit
  table — 2xx green, 4xx/5xx red, so an outage's worth of 401s
  stops looking identical to the 2xx steady-state. #253
- **`OMCP_TRUST_PROXY`** opt-in for reverse-proxy deployments —
  audit IPs, per-IP rate-limit buckets and the Secure cookie attribute
  all start seeing the real client through nginx / Envoy / ingress
  controllers. Off by default so a forged `X-Forwarded-For` can't
  impersonate a different IP on a public listener. #254
- **`make doctor`** gained a third probe — `/api/me` reports the
  active auth mode + authenticated state alongside the existing
  `/healthz` + MCP-handshake checks. #255
- **`/api/info` governance block** — booleans-only public posture
  snapshot (`authMode`, `authSecretEphemeral`, `auditPersisted`,
  `catalogConfigured`, `redaction`, `trustProxy`, `toolRatePerMin`)
  for external dashboards to alert on "production silently reverted
  to anonymous mode" without holding a session cookie. #257
- **Access-control runbook gets a TOC + Posture-discovery section** so
  the 280-line doc is one-screen navigable and the new `/api/info`
  governance block has a documented schema. #258
- **`MAX_REDACT_DEPTH=64`** on the redactValue walker — defensive
  stack-overflow cap for pathologically deep JSON. #259
- **Catalog enrichment in the Web UI** — owner / tier / on-call chips
  inline on each Services row, plus a full Catalog section in the
  service detail drawer (description, SLO, data classification,
  runbooks, tags) when `OMCP_SERVICE_CATALOG_FILE` is configured.
  #260, #262
- **README quickstart points at `docs/access-control.md`** so multi-user
  teams reach the runbook without scrolling to the deep Docs index.
  #261
- **Luhn-checked credit-card redaction pattern** added to the
  `query_logs` redactor — order IDs / timestamps stay intact because
  the redactor only fires on numbers that actually pass Luhn. #263
- **Login modal remembers the last-used username** via localStorage and
  jumps focus straight to the password field on next sign-in. Password
  never persists. #264
- **Helm fragment fix in the access-control runbook** — the snippet
  showed `env:` (a map) where the chart's actual key is `extraEnv:`
  (a `[{name,value}]` list). Operators copying the snippet to
  production would have hit a Helm validation error. #265
- **Colour-coded `resource:action` column** in the Management changes
  audit table — write rows draw the eye in accent-blue, delete rows
  in danger-red, read rows recede in muted grey. #266
- **Anonymous audit entries render in muted italic** so a deployment
  that silently lost its auth is obvious in the feed. #267
- **Ephemeral-session-secret banner** at the top of the UI — fires
  when `OMCP_AUTH=basic` is set but `OMCP_SESSION_SECRET` is not, so
  the operator learns that sessions will die on restart before the
  first incident teaches them the hard way. #268
- **Helm `values.yaml` documents the v1.8.0 env vars** in the
  `extraEnv:` block comment — `helm show values` now lists every
  `OMCP_*` knob with a one-line description, plus a 3-key
  copy-pastable example (basic auth + `secretKeyRef` for the
  session secret). #270
- **OpenAPI 3.1 spec covers `/api/info`** with a full schema for the
  `governance` posture block (authMode, authSecretEphemeral,
  auditPersisted, catalogConfigured, redaction, trustProxy,
  toolRatePerMin). Codegen-friendly. #274
- **`scripts/verify-audit.mjs` documentation cross-links** —
  `docs/auth-basic.md` and `docs/redaction.md` now link back to the
  one-stop access-control runbook. #273

### Changed
- **`OMCP_TOOL_RATE_PER_MIN` parsing centralised** behind a single
  `resolveToolRatePerMin()` helper used by `/api/info`, `/api/usage`,
  and the limiter itself. `0` / negative / non-numeric now fall back
  to the documented default 60 (previously `-1` made the limiter
  reject every request; `0` similarly locked everyone out). #276, #277
- **IPv6 redaction runs before IPv4** so IPv4-mapped addresses
  (`::ffff:192.168.1.42`) are classified as a single IPv6 leaf rather
  than leaving a half-redacted `::ffff:[redacted-ipv4]` token. #272

### Fixed
- **`GET /api/audit?limit=foo`** previously returned an empty array
  because `parseInt("foo", 10)` is NaN and the loop's
  `out.length < NaN` was always false. Non-finite / non-positive
  limits now coerce to the 100 default; positive decimals floor. #278
- **`mcp-server/src/policy/redact.ts` docstring** corrected to match
  reality — the file claimed a `redaction:bypass` RBAC permission
  shipped today, but per-request bypass is on the roadmap; only
  process-wide `OMCP_REDACTION=off` exists. #271

### Internal
- **`mcp-server/src/openapi.test.ts`** pins the 17 documented
  `/api/*` routes plus the `/api/info` governance-block schema shape
  so a future undocumented endpoint trips the test instead of
  shipping silently. #275
- **IPv6 redaction tests** cover full / compressed / `::1` /
  IPv4-mapped forms — closes a coverage gap the regex already had. #272

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
