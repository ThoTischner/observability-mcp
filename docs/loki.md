# Loki connector

Loki streams identify services through different labels depending on the shipper. The connector probes a prioritized list and uses the **first label that returns any values** — it does not union across labels, so a noisy low-priority label (e.g. a host-wide `container` label that also sees unrelated containers) can't pollute discovery while a curated higher-priority label is present.

## Service label fallback

Default order:

1. `service_name`  (OpenTelemetry, modern Grafana Agent / Alloy)
2. `service`       (legacy convention)
3. `job`           (Promtail/Alloy default for static_configs)
4. `app`           (Kubernetes labelling convention)
5. `container`     (Docker `loki.source.docker`)

`list_services` returns the values of the **first label in the order above that has any** (the ordered fallback still keeps streams reachable on backends that only carry a low-priority label), annotating each service with the label it was discovered through (`labels.discoveredVia`).

`query_logs(service=X)` resolves `X` to the first label whose values contain it, then builds `{<label>="X"}` as the LogQL selector.

Override the order via `LOKI_SERVICE_LABELS`:

```bash
LOKI_SERVICE_LABELS=service_name,container,job npx @thotischner/observability-mcp
```

Label values are cached per-label for 60 seconds.

## Structured label filters (`labels`)

`query_logs` accepts a `labels` map of exact-match filters on
backend-extracted fields, AND'd together. For structured JSON access
logs this is far more reliable than the `query` regex — a natural
filter like `GET /` never appears verbatim in
`{"method":"GET","url":"/"}`.

```jsonc
query_logs({
  "service": "app",
  "labels": { "method": "GET", "url": "/", "status": "200", "environment": "prod" }
})
```

These compile to LogQL label-filter expressions **after** `| json`, so
they work on fields the pipeline extracts, not just stream labels:

```logql
{service_name="app"} | json | environment="prod" | method="GET" | status="200" | url="/"
```

`environment` (or any label) is therefore a first-class filter — handy
when prod and dev logs share one backend. A `level` filter and a free-
text `query` (line filter) still compose on top. Label names must match
`[a-zA-Z_][a-zA-Z0-9_]*` (max 20); values are escaped. An invalid name
or value is rejected fail-closed rather than silently dropped.

### Level from HTTP status

When a structured line carries no explicit `level` but does carry an
HTTP `status`, the connector derives one — `5xx → error`, `4xx → warn` —
so access logs are triageable and `level`-filterable without a
dedicated level field.

## Server-side aggregation (`aggregate`)

For analytics-style questions ("how many requests, top paths, per-route
counts") pulling raw rows and counting by hand collapses at volume and
hits `limit`. The `aggregate` parameter pushes the work down to LogQL
metric queries so you get a **number, not a haystack**:

```jsonc
// Busiest paths in the last hour
query_logs({ "service": "app", "duration": "1h",
             "aggregate": { "op": "topk", "by": ["url"], "k": 10 } })

// Requests per status code over the window
query_logs({ "service": "app", "duration": "1h",
             "aggregate": { "op": "sum", "by": ["status"] } })

// Time series of request counts, 15-minute buckets
query_logs({ "service": "app", "duration": "6h",
             "aggregate": { "op": "count_over_time", "by": ["url"], "step": "15m" } })
```

| op | LogQL | result |
|---|---|---|
| `topk` | `topk(k, sum by (…) (count_over_time({…}[window])))` | top-k groups by total (instant) |
| `sum` | `sum by (…) (count_over_time({…}[window]))` | total per group (instant) |
| `count_over_time` | `sum by (…) (count_over_time({…}[step]))` | time series per group (range) |

`labels` and `query` filters apply **before** aggregation, so you can
e.g. `topk` paths within `{environment="prod", method="GET"}`. `topk`
requires at least one `by` label to rank. `limit` does not apply in
aggregate mode (the response says so in its `note`) — results are grouped
counts, not rows. Validation is fail-closed: a bad `op`, `by` label,
`k`, or `step` rejects the request.

## Docker container label leading slash

Docker's `loki.source.docker` writes container names with a leading `/` (Docker's `Names[0]` convention — `/my-app-1`). The connector handles this transparently:

- `list_services` strips the leading `/` from container values for display, so the advertised name passes the service-name validator.
- `query_logs(service="my-app-1")` matches `/my-app-1` in Loki and builds `{container="/my-app-1"}` as the selector.

You don't need to know whether a service is Docker-shipped — the input is always the clean name.

## Health check

The connector probes `/loki/api/v1/labels` instead of `/ready`. This works on managed Loki (Grafana Cloud, AWS, etc.) where the operational health endpoint is not exposed.
