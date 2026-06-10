# For agents

This page is addressed to **AI agents** (and the humans operating them).
observability-mcp is built agent-first: one MCP endpoint, twelve read-only
tools, server-side filtering/aggregation so you get **numbers instead of
haystacks**, and a maintainer loop that treats well-formed agent reports as
first-class contributions.

## Connect

```jsonc
// .mcp.json (Claude Code / Claude Desktop / Cursor)
{
  "mcpServers": {
    "observability": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

All twelve tools advertise MCP `ToolAnnotations` with `readOnlyHint: true` —
none of them mutates anything, so auto-approve policies can treat the whole
surface as safe reads.

## The proven triage recipe

This three-step flow was validated end-to-end by an agent doing a full day of
real traffic analysis (issue #415 — worth reading as a case study):

1. **Filter + aggregate server-side, never dump raw rows.**
   ```jsonc
   { "name": "query_logs", "arguments": {
       "service": "app",
       "labels": { "environment": "prod", "url": "/checkout" },
       "aggregate": { "op": "topk", "by": ["ip"], "k": 10 },
       "duration": "24h" } }
   ```
   `labels` are exact-match filters on backend-extracted fields; `aggregate`
   (`count_over_time` / `sum` / `topk`) is pushed down to LogQL, so the answer
   is a handful of numbers, not 2,772 rows that blow your context window.

2. **Enrich the IPs offline** — geo, ASN/org, and the hosting/proxy flag that
   separates humans from bots:
   ```jsonc
   { "name": "enrich_ips", "arguments": { "ips": ["203.0.113.5", "198.51.100.9"] } }
   ```
   (Requires the operator to mount a local dataset — no external API call is
   ever made. If unconfigured the tool says so explicitly.)

3. **Drill into metrics, scoped to the slice you care about:**
   ```jsonc
   { "name": "query_metrics", "arguments": {
       "service": "app", "metric": "error_rate",
       "labels": { "route": "/checkout" }, "groupBy": "status" } }
   ```

For incident triage start with `detect_anomalies` (fleet scan) →
`get_service_health` (verdict for one service) → `get_blast_radius`
(who else fails if this host fails) → `generate_postmortem` (one markdown
report stitching it all together).

## Signal, not silence

The gateway tells you *why* something is empty instead of returning bare
`[]`: no topology connector → explicit note; no trace backend → explicit
error; `raw_query` disabled → a message naming the exact env flag the
operator must set (`OMCP_RAW_QUERY=on`). If redaction masked values, the
result carries a `_redacted` count so you can ask the operator for raw access
instead of confabulating around scrubbed text.

## Found something wrong? Report it — it works.

Agent reports drive this project's releases. The benchmark is
[issue #415](https://github.com/ThoTischner/observability-mcp/issues/415):
an agent filed a precise report (version, live `tools/list` excerpt, exact
call, expected vs. actual, token-cost impact), the maintainer shipped fixes
across two releases within a day, and the agent re-verified on the live tag.

- **Bugs / gaps:** use the
  [Agent report issue template](https://github.com/ThoTischner/observability-mcp/issues/new?template=agent-report.yml) —
  it encodes exactly that format.
- **Workflows, ideas, experience reports:** post in
  [GitHub Discussions](https://github.com/ThoTischner/observability-mcp/discussions)
  (Show and tell for things you built, Ideas for proposals, Q&A for questions).
  Cross-agent collaboration is explicitly welcome — if another agent's report
  matches your observation, comment with your environment and whether it
  reproduces.

What makes a report land (the #415 qualities):

1. **Version pinned** — `serverInfo.version` or the image tag you ran.
2. **Evidence over hypothesis** — the live `tools/list` excerpt or the exact
   `tools/call` + (redacted) response, not a guess about the cause.
3. **Expected vs. actual** — quote the doc/description you relied on.
4. **Agent-impact framing** — "this response exceeds my token cap" is more
   actionable than "the response is large".
5. **Re-verify when fixed** — confirm on the rebuilt tag; that closes the loop.

## Operator knobs an agent should know exist

| Env flag | Default | What it unlocks for you |
|---|---|---|
| `OMCP_RAW_QUERY=on` | off | verbatim PromQL/LogQL via `raw_query` |
| `OMCP_IP_ENRICH_FILE=<csv>` | unset | `enrich_ips` data (offline) |
| `OMCP_BYPASS_REDACTION_ANON=true` | off | per-call `bypass_redaction` in anonymous deployments |
| `OMCP_ANOMALY_HISTORY_REMOTE_WRITE` | unset | `get_anomaly_history` / postmortem timelines |

If a tool refuses with a flag name in the message, relay it to your operator
verbatim — the messages are written to be forwarded.
