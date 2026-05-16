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

## Docker container label leading slash

Docker's `loki.source.docker` writes container names with a leading `/` (Docker's `Names[0]` convention — `/my-app-1`). The connector handles this transparently:

- `list_services` strips the leading `/` from container values for display, so the advertised name passes the service-name validator.
- `query_logs(service="my-app-1")` matches `/my-app-1` in Loki and builds `{container="/my-app-1"}` as the selector.

You don't need to know whether a service is Docker-shipped — the input is always the clean name.

## Health check

The connector probes `/loki/api/v1/labels` instead of `/ready`. This works on managed Loki (Grafana Cloud, AWS, etc.) where the operational health endpoint is not exposed.
