# Raw query passthrough (`raw_query`)

The curated `query_metrics` / `query_logs` parameters cover the common
cases safely, but an agent sometimes needs a query the catalog can't
express — an arbitrary PromQL function, a metric outside the catalog,
or a hand-written LogQL selector/pipeline. The `raw_query` escape hatch
covers those, **gated behind an explicit operator capability and off by
default**.

## Enabling

```bash
OMCP_RAW_QUERY=on      # also accepts: true, 1
```

When unset (the default) any call that passes `raw_query` is refused
with a clear message — the param is still *advertised* in `tools/list`
(so an agent can discover it and explain the requirement), but the
server will not execute it.

## Usage

`query_metrics` — verbatim PromQL run over the look-back range:

```jsonc
{ "raw_query": "topk(5, sum by(route) (rate(http_requests_total[5m])))", "duration": "1h" }
```

`query_logs` — verbatim LogQL log query:

```jsonc
{ "raw_query": "{app=\"checkout\", env=\"prod\"} | json | status>=`500`" }
```

When `raw_query` is set, the curated params are ignored:

| Tool | Ignored when `raw_query` is set |
|---|---|
| `query_metrics` | `service`, `metric`, `groupBy`, `labels` |
| `query_logs` | `service`, `labels`, `level`, `query` (and it is mutually exclusive with `aggregate` — express the aggregation in the LogQL itself) |

`duration` (and `source`, on `query_metrics`) still apply. For **log aggregation**
(counts, top-k) prefer the structured `aggregate` param on
`query_logs` — it is available without the raw-query capability.

## Why it is gated

A raw query bypasses the curated safe surface:

- it can hit any series/stream the backend exposes, not just the
  catalog-scoped ones, so it sidesteps the metric allow-list;
- it is still **tenant-scoped** (it only runs against backends in the
  caller's tenant) and respects the per-credential **source
  allow-list**, but within a reachable backend it can read anything;
- `query_logs` raw output is still **redacted** like any other log
  result (subject to the usual per-call bypass rules).

Because of the widened read surface, enable `raw_query` only in trusted
/ single-tenant deployments where the calling agents are allowed
ad-hoc query access. Leave it off for shared multi-tenant gateways and
rely on the curated `labels` / `aggregate` params instead.

The query string is sent to the backend verbatim — there is no
server-side syntax validation, so an invalid query simply returns the
backend's own parse error.
