# How observability-mcp compares to adjacent tools

This page is an **honest, source-cited comparison** of observability-mcp against
three categories of tools people most often ask "is this just X?" about:
agentic incident-response platforms (Datadog AI / Bits AI), open-source
LLM-driven SRE assistants (HolmesGPT), and OSS observability automation
(Robusta).

Every cell links to the public source that backs the claim. No invented numbers.
Snapshot date: 2026-05. Things change — open a PR (or an issue) if a cell goes
stale and we will fix it.

> **What this page is _not_.** It is not a head-to-head benchmark of these
> products. Each occupies a different shape of problem (managed SaaS vs.
> self-hosted, alert-first vs. agent-first, one backend vs. many). The
> comparison is meant to help you decide where each fits, not which one "wins".

---

## At a glance

| Dimension | observability-mcp | Datadog Bits AI | HolmesGPT | Robusta OSS |
|---|---|---|---|---|
| **License** | Apache 2.0 [^omcp-license] | Proprietary SaaS [^dd-pricing] | MIT [^holmes-repo] | MIT [^robusta-repo] |
| **Self-hosted** | Yes (single binary / Docker / Helm) [^omcp-readme] | No (cloud SaaS) [^dd-pricing] | Yes [^holmes-repo] | Yes [^robusta-repo] |
| **MCP-native** (exposes Streamable HTTP / stdio MCP server) | Yes — 8 tools, full Streamable HTTP transport [^omcp-readme] | No first-party MCP server documented as of 2026-05; Datadog's agent answers in-app [^dd-bits-faq] | No — Python tool-calling library [^holmes-repo] | No — Slack/web UI focus [^robusta-repo] |
| **Topology-aware reasoning** (graph tools the LLM can call) | Yes — `get_topology` + `get_blast_radius` over a generic `kind`/`relation` vocabulary [^omcp-topo] | Limited — Datadog has service maps, but not as agent-callable structured tools at the MCP layer [^dd-services] | No — focused on Kubernetes events + log/metric retrieval [^holmes-repo] | Partial — Kubernetes-event correlation, but no LLM-callable graph traversal [^robusta-repo] |
| **Reproducible RCA benchmark in-tree** | Yes — `scripts/benchmark-rca.mjs`, raw JSON in `docs/benchmark-results/`, three-scenarios doc [^omcp-bench] | No public reproducible accuracy benchmark | No public benchmark of comparable shape (deterministic local model, A/B with vs without tools) | No public benchmark of comparable shape |
| **Multi-backend** (one server, several observability backends) | Yes — Prometheus, Loki, Kubernetes, Tempo, pluggable [^omcp-readme] | N/A — single vendor [^dd-pricing] | Yes (Prometheus, Loki, K8s, … via separate adapters) [^holmes-repo] | Kubernetes-first, integrates Prometheus + others as alert sources [^robusta-repo] |
| **Local LLM support** (Ollama / vLLM / self-hosted) | Yes — agent ships with Ollama wiring; no cloud calls required [^omcp-readme] | No — Bits AI is hosted by Datadog [^dd-bits-faq] | Yes — supports many backends incl. Ollama [^holmes-repo] | Yes — supports OpenAI-compatible, incl. local [^robusta-repo] |

---

## When each is the right pick

**observability-mcp** is the right pick when:
- You already run Prometheus + Loki (and maybe Tempo, Kubernetes) and want
  one MCP endpoint your agent talks to, not one per backend.
- You care about topology-shaped questions: "if this pod's node dies, who
  else falls over?", "what other services depend on this DB?".
- You want a reproducible accuracy benchmark you can re-run on your own
  hardware before believing the marketing.

**Datadog Bits AI** is the right pick when:
- You are already deep in the Datadog ecosystem (APM, logs, infra, RUM).
- You accept SaaS-only and per-host / per-GB pricing.
- You want a polished in-product agent UX without operating infrastructure.

**HolmesGPT** is the right pick when:
- You want a Python-native, code-first investigation library to embed in
  your own runbook / Slack bot.
- You're investigating mostly Kubernetes events + Prometheus alerts.
- You're comfortable with a tool-calling library (not an MCP server).

**Robusta** is the right pick when:
- Your primary surface is Slack / web UI, and most alerts come from
  Kubernetes / Prometheus AlertManager.
- You want pre-built playbooks for common K8s incidents.

---

## Why we built this anyway

The above tools all exist and several are excellent at their shape. We
built observability-mcp because none of them combine all three of:

1. **MCP-native** — so any MCP-speaking agent (Claude Code, Claude
   Desktop, Cursor, custom) can use it with one `.mcp.json` line, not a
   wrapper.
2. **Topology-aware** at the tool layer — not as a UI feature buried in a
   dashboard, but as a tool the LLM can call mid-investigation.
3. **Honest, reproducible accuracy benchmark** in the repo — not a marketing
   slide, raw JSON outputs alongside the harness so anyone can re-run it.

The benchmark headline (`baseline 0/10 → topology 10/10` on a real
cross-namespace blast-radius question, llama3.1:8b, n=10) lives in
[docs/benchmark-astronomy-shop.md](benchmark-astronomy-shop.md). It is
deliberately scoped narrow: we do **not** claim universal speedup, and the
same doc shows scenarios where topology tools cost more without helping.

---

## Sources

[^omcp-license]: `LICENSE` in this repo.
[^omcp-readme]: [`README.md`](https://github.com/ThoTischner/observability-mcp/blob/main/README.md) in this repo.
[^omcp-topo]: [`docs/topology-vocabulary.md`](topology-vocabulary.md) — the canonical `kind`/`relation` contract.
[^omcp-bench]: [`docs/benchmark-astronomy-shop.md`](benchmark-astronomy-shop.md) — methodology + raw JSON in `docs/benchmark-results/`.
[^dd-pricing]: <https://www.datadoghq.com/pricing/>
[^dd-bits-faq]: <https://docs.datadoghq.com/bits_ai/>
[^dd-services]: <https://docs.datadoghq.com/tracing/services/services_map/>
[^holmes-repo]: <https://github.com/robusta-dev/holmesgpt>
[^robusta-repo]: <https://github.com/robusta-dev/robusta>
