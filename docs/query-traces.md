# `query_traces` — distributed traces tool

The ninth MCP tool, shipped in v3.0. Fans out across every
connector implementing the optional `queryTraces` capability,
merges the returned spans, recomputes p50 / p95 over the merged
set, and returns ranked trace summaries the agent can drill into.

## When to use

- Drilling into a latency spike a metric flagged.
- Answering "show me the 5 slowest checkout-service traces in the
  last 15 minutes" without remembering the backend query language.
- Pairing with `get_blast_radius` and `query_logs` for a full
  incident triage.

For the metrics/logs pieces of an incident use the matching
`query_metrics` / `query_logs` tools.

## Prerequisites

At least one configured source whose connector implements
`queryTraces`. As of v3.0 that means an OTLP-shaped Tempo
deployment via the bundled `tempo` connector (P3 in the
production-readiness sprint adds the actual `queryTraces`
implementation to the plugin; until P3 lands the tool returns
empty even when Tempo is configured — track via
`/api/info.governance.tracesCapabilityCount`).

You can verify the gateway sees at least one provider:

```bash
curl -s http://localhost:3000/api/info | jq '.governance.tracesCapabilityCount'
# expect: > 0 once a queryTraces-capable connector is configured
```

## Schema

```jsonc
{
  "name": "query_traces",
  "inputSchema": {
    "type": "object",
    "properties": {
      "service":    { "type": "string", "description": "Service name to search for." },
      "duration":   { "type": "string", "description": "Window length, e.g. '15m', '1h'. Default '15m'." },
      "filter":     { "type": "string", "description": "Backend-native filter (TraceQL on Tempo, tag query on Jaeger). Optional." },
      "limit":      { "type": "number", "description": "Soft cap on returned trace summaries. Default 50." },
      "errorsOnly": { "type": "boolean", "description": "If true, restrict to traces carrying at least one error span." }
    },
    "required": ["service"]
  }
}
```

## Output shape

```jsonc
{
  "service": "checkout",
  "duration": "15m",
  "sources": ["tempo-prod"],
  "summary": {
    "total":          12,
    "errorCount":     2,
    "p50DurationMs":  410,
    "p95DurationMs":  1180
  },
  "traces": [
    {
      "traceId":     "1a2b3c…",
      "rootName":    "POST /checkout",
      "rootService": "checkout",
      "durationMs":  1240,
      "spanCount":   17,
      "hasError":    false
    }
  ],
  "errors": ["tempo-staging: connect ECONNREFUSED"]  // only present on partial-failure
}
```

`sources` is the flat list of source names whose connectors
returned. `summary` aggregates over the (capped) merged set —
the percentiles are NOT the source-of-truth backend p95 for SLO
reporting; query the backend directly for that. `errors`
appears only on partial-failure runs (one connector errored,
others succeeded).

## Example call

```bash
curl -sS http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SESSION" \
  --data '{
    "jsonrpc":"2.0", "id":1, "method":"tools/call",
    "params": {
      "name":"query_traces",
      "arguments":{"service":"checkout","duration":"15m","errorsOnly":true}
    }
  }'
```

## RBAC

The tool calls `enforceEntitledAccess(ctx, {tool: "query_traces", service})`
which routes through the same per-credential `OMCP_KEY_PRODUCTS`
allow-list + Product binding the existing data-query tools use.
Bind the tool into the Product(s) you want to expose. See
[access-control.md](access-control.md) and
[products.md](products.md).

## Troubleshooting

- **Empty `traces` against a working Tempo** — usually means the
  active connector implements `queryMetrics` (topology) but not
  `queryTraces`. Check `/api/info.governance.tracesCapabilityCount`.
- **`p50_ms` looks too low** — by design: percentiles are computed
  AFTER the merge across the (capped) returned set, not over the
  full backend population. Use the source-of-truth backend for SLO
  reports.
- **Auth 403 with permission appearing in policy** — the tool
  enforces tenant scoping; verify the calling identity's tenant
  matches the connector's tenant binding (`sources.yaml`).

## Related

- [`get_anomaly_history`](anomaly-history.md) — pair with replayed
  scores to see whether a slow trace correlates with a known
  anomaly window.
- [`generate_postmortem`](postmortems.md) — bundles
  `query_traces` output into the markdown report so the post-mortem
  carries concrete trace IDs.
