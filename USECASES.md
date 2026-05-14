# Use cases

Five concrete scenarios with the prompts that drive them. All assume `observability-mcp` is reachable at `http://localhost:3000/mcp` (the default after `make demo` or `npx @thotischner/observability-mcp`).

If you've wired Claude Code via `.mcp.json` (already committed in this repo) you can just paste the prompts into a Claude session — Claude picks the tools itself.

---

## 1. Incident detection — "what's broken right now?"

> *"Are there any anomalies right now? Walk me through what's happening."*

Claude calls `detect_anomalies`, then `query_logs` on the affected service, then summarises. Example output during a chaos `error-spike` on `payment-service`:

```
payment-service is degraded (health 79/100):
  • CPU 3.3σ above baseline (17.94 → 38.75 %)
  • 7 error logs in the last 5 min, top pattern:
    "Request failed: internal error during POST /payments (4x)"
  • Correlated: metric anomaly + log errors started within
    the same minute → likely the same root cause
```

No PromQL, no LogQL written by you or the agent. The cross-signal correlator did the join.

**Why this is hard without the gateway:** the agent would need 3 separate MCP servers (Prometheus, Loki, an aggregator), would have to learn both query languages, and would still miss the temporal correlation.

---

## 2. Cost optimisation — "where are we over-provisioned?"

> *"List services whose CPU and memory baselines are sitting below 30 % of their requests over the last day. Prioritise the ones with the most replicas."*

The agent uses `list_services`, then `query_metrics` per service for `cpu_usage` and `memory_usage`, joins against the deployment manifests (via your k8s MCP server or any tool you have for that). The output becomes a candidate list for right-sizing.

This is the kind of weekly report SRE teams pay platform engineers to write manually. Drive it from one Slack message instead.

---

## 3. SLO monitoring — "are we burning error budget?"

> *"For the api-gateway service, what's the 7-day p99 latency trend and how many minutes were above the 500ms SLO?"*

`query_metrics` with a range query against `histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{service="api-gateway"}[5m]))`, then the agent counts samples exceeding 0.5. Burn-rate calculation in the agent's reasoning step, not in PromQL.

Drop this prompt into a weekly scheduled Claude run and you get a burn-rate report without touching Grafana.

---

## 4. On-call triage — "I just got paged, what should I look at first?"

> *"The on-call alert says high latency on order-service. What's the most likely cause? Check metrics and logs from the last 30 minutes and rank hypotheses."*

The agent:
1. `get_service_health` for the named service → score + status + anomalies
2. `query_logs` filtered to ERROR/WARN in the time window → top patterns
3. `query_metrics` on `cpu`, `memory`, `request_rate`, `latency_p99` to see what shifted
4. Cross-references against `detect_anomalies` for correlated services upstream/downstream

The output is a ranked hypothesis list with evidence — exactly what an experienced SRE produces in the first 5 minutes, compressed to 15 seconds.

---

## 5. Multi-cloud observability — "what's the state across all our backends?"

> *"Compare error rates across our three Loki sources (us-east, eu-west, ap-south). Are any regions degraded?"*

Each region has its own Loki instance, each is configured as a separate source. `list_sources` shows them all, `query_logs` accepts a `source` parameter so the agent can fan out. The agent normalises and produces a regional comparison without you needing to log into three Grafana workspaces.

Same pattern works for hybrid Prometheus/Mimir/VictoriaMetrics deployments, or for Datadog + open-source side by side once the Datadog connector lands ([Roadmap](ROADMAP.md)).

---

## Common building blocks

Most of these end up calling the same handful of tools — that's the point of having a unified gateway:

| Tool | What it's for |
|---|---|
| `list_sources` | Discover configured backends and connection status |
| `list_services` | Cross-backend service inventory |
| `query_metrics` | Point or range query against any metrics source |
| `query_logs` | LogQL or backend-specific log query with summary stats |
| `get_service_health` | Cross-signal health (0–100) + anomalies + correlations |
| `detect_anomalies` | Z-score anomaly scan across all monitored services |

Anything more specific that you want to build, the connector interface (`mcp-server/src/connectors/interface.ts`) is one file — see [`docs/connectors.md`](docs/connectors.md) and [`docs/plugin-architecture.md`](docs/plugin-architecture.md) for the plugin pipeline.
