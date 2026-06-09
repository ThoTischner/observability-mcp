# `generate_postmortem` — auto-generated incident reports

The eleventh MCP tool, shipped in v3.0. Stitches the gateway's
existing primitives — anomaly history, trace summaries, topology
blast-radius, log highlights — into a single markdown report a
human reads in one shot.

## When to use

- After an incident, when you (or the on-call agent) want one
  document instead of poking five tools by hand.
- For a "context handoff" — pasted into a Slack thread or ticket
  the next shift picks up.
- As LLM context for retro / blameless-postmortem prep.

## Prerequisites

The tool degrades gracefully — every section either renders or
explicitly states "no data". For a full report you want:

- **Anomaly history sink active** — wire
  `OMCP_ANOMALY_HISTORY_REMOTE_WRITE` (see
  [anomaly-history.md](anomaly-history.md)) AND ensure
  `/api/info.governance.anomalyHistoryActive` reports `true`.
- **At least one traces-capable connector** — see
  [`query_traces`](query-traces.md). Without one the "Related
  traces" section says so explicitly.
- **A topology provider** for blast-radius (Kubernetes connector
  ships with one out of the box).
- **A logs connector** (Loki by default).

A report is still useful with only metrics + topology.

## Schema

```jsonc
{
  "name": "generate_postmortem",
  "inputSchema": {
    "type": "object",
    "properties": {
      "service":  { "type": "string", "description": "Suspected root-cause service." },
      "duration": { "type": "string", "description": "Window length, e.g. '1h', '6h'. Default '1h'." },
      "format":   { "type": "string", "description": "'markdown' (default) or 'json'." }
    },
    "required": ["service"]
  }
}
```

## Output

Default `markdown`. The structured JSON shape is identical to the
markdown body but parseable — useful if you want to render in a
custom UI.

The markdown body always contains these sections, in order:

1. **Synopsis** — one paragraph: window, peak score, blast-radius
   size, error-trace count.
2. **Anomaly timeline** — capped at 20 rows (the full timeline
   lives in the JSON shape).
3. **Blast radius at peak** — capped at 30 nodes.
4. **Contributing signals (ranked)** — top 10 signals by mean score.
5. **Related traces** — up to 10 traces, error traces called out.
6. **Log highlights** — present only when log highlights were
   extracted.
7. **Suggested follow-ups** — derived from the failure modes
   (critical-peak threshold, blast-radius size, log-pattern
   presence).

## Example

```bash
SESSION=...  # from /mcp initialize

curl -sS http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SESSION" \
  --data '{
    "jsonrpc":"2.0", "id":1, "method":"tools/call",
    "params": {
      "name":"generate_postmortem",
      "arguments":{"service":"checkout","duration":"6h"}
    }
  }' | jq -r '.result.content[0].text'
```

## RBAC

The tool calls `enforceEntitledAccess(ctx, {tool: "generate_postmortem", service})`
which routes through the standard per-credential
`OMCP_KEY_PRODUCTS` allow-list + Product binding. Bind the tool
into the Product(s) you want to expose. See
[access-control.md](access-control.md) and
[products.md](products.md).

## Persistence

Generated reports can be persisted on the management plane (the
`generate_postmortem` MCP tool itself is stateless and still returns the
markdown to the caller). The endpoints:

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/api/postmortems` | `{service, duration}` — regenerates (forces `format=json`), stores, and returns the saved entry. |
| `GET` | `/api/postmortems` | List stored reports, tenant-scoped, newest first. |
| `GET` | `/api/postmortems/:id` | Fetch one stored report. |
| `DELETE` | `/api/postmortems/:id` | Delete one (admin-gated). |

Storage is an append-only JSONL file at `OMCP_POSTMORTEMS_FILE`
(default `/tmp/postmortems.jsonl`); entries are tenant-scoped. The
Postmortems UI tab lists and opens stored reports. If you only need the
report at the call site, ignore the API and use the markdown the tool
returns.

## Failure modes the tool handles

| Situation | Report behaviour |
|---|---|
| Anomaly-history sink not configured | Synopsis says "no scores recorded" + follow-up suggests enabling `OMCP_ANOMALY_HISTORY_REMOTE_WRITE` |
| No traces-capable connector | "Related traces" section is omitted with a note |
| Topology provider down | "Blast radius" section is omitted with a note |
| Logs connector returns empty | "Log highlights" section is omitted entirely |

Every section is independently optional so a half-configured
deployment still produces SOMETHING useful instead of failing.

## Related

- [`query_traces`](query-traces.md) — drill into a specific
  trace ID surfaced in the report.
- [`get_anomaly_history`](anomaly-history.md) — replay the raw
  scores the timeline is built from.
- [`get_blast_radius`](topology-vocabulary.md) — interrogate the
  blast-radius graph for a specific resource id.
