# Prometheus connector

Default queries target **prom-client** conventions — the de-facto standard for Node.js/Express instrumentation. Most apps that expose `/metrics` via prom-client work out of the box without any source-level overrides.

## Default metrics

For each synthetic metric the connector probes a list of candidate series and picks the first one that actually exists in the backend. This makes the same MCP work for prom-client apps **and** node_exporter hosts without per-source configuration.

| Metric | First candidate (prom-client) | Fallback (node_exporter) |
|--------|-------------------------------|--------------------------|
| `cpu` | `rate(process_cpu_seconds_total[1m]) * 100` | `100 - avg(rate(node_cpu_seconds_total{mode="idle"}[1m])) * 100` |
| `memory` | `process_resident_memory_bytes` | `node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes` |
| `request_rate` | `sum(rate(http_requests_total[1m]))` | — (HTTP-app concept) |
| `error_rate` | `sum(rate(http_requests_total{status=~"5.."}[1m]))` | — |
| `latency_p99` | `histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[1m])) by (le))` | — |
| `latency_p50` | same with quantile `0.50` | — |
| `latency_avg` | `sum(rate(_sum[1m])) / sum(rate(_count[1m]))` | — |

The probe queries `/api/v1/series?match[]=<seriesName>{<label>="<service>"}` for each candidate **per service** (cached 60 s), so a Prometheus that holds both prom-client apps and node_exporter hosts in the same instance still picks the right candidate per service. The selected candidate is reflected in the response's `resolvedSeries` field.

## Dynamic label resolution

The `{{selector}}` placeholder is resolved at query time. The connector probes a list of labels and uses the first one that contains the requested service name as a value:

1. `job`
2. `service`
3. `app`
4. `service_name`

So `query_metrics(service="my-app")` issues `/api/v1/label/job/values`, finds `my-app`, then runs `... process_cpu_seconds_total{job="my-app"} ...`.

If no label matches, the first label in the list is used as a fallback. Override the order via `PROMETHEUS_SERVICE_LABELS`:

```bash
PROMETHEUS_SERVICE_LABELS=service,job npx @thotischner/observability-mcp
```

Label values are cached per-label for 60 seconds.

## `resolvedSeries` and `resolvedLabel`

Every `query_metrics` response includes the actual PromQL executed and the label that was matched. When results look surprising, check these first.

```json
{
  "metric": "cpu",
  "values": [...],
  "resolvedSeries": "rate(process_cpu_seconds_total{ job=\"my-app\" }[1m]) * 100",
  "resolvedLabel": "job"
}
```

## Overriding a single metric

Source-level `metrics` entries merge with defaults by name. Pin one metric without re-listing the rest:

```yaml
sources:
  - name: prometheus
    type: prometheus
    url: http://prometheus:9090
    enabled: true
    metrics:
      - name: cpu
        query: 'my_custom_cpu_gauge{job="{{service}}"}'
        unit: percent
        description: Project-specific CPU metric
```

`{{service}}` (literal name) and `{{selector}}` (full `label="value"` pair) are both supported in custom queries.

## Compatibility with managed Prometheus

The connector works with **Grafana Cloud Mimir**, **AWS Managed Prometheus**, and **Chronosphere** without flags. Health checks probe `/api/v1/query?query=up` and service discovery falls back to `/api/v1/label/job/values` when `/api/v1/targets` is unavailable.
