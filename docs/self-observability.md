# Self-observability — tracing the gateway

The gateway can emit OpenTelemetry traces about its own behaviour: every
`/api/*` request and every `/mcp` JSON-RPC call becomes a span, with HTTP
auto-instrumentation. This is **opt-in** so the demo and any deployment
that does not run a collector stays silent.

> When this is on, the gateway is both the producer and consumer of
> observability data. That is the intended product story: the same tool
> AI agents use to reason about your stack also reasons about itself.

## Enable

Set `OMCP_OTEL_ENABLED=true` and point `OMCP_OTEL_ENDPOINT` at an OTLP/HTTP
traces endpoint.

```bash
export OMCP_OTEL_ENABLED=true
export OMCP_OTEL_ENDPOINT=http://tempo:4318/v1/traces
# Optional collector auth:
export OMCP_OTEL_HEADERS="Authorization=Bearer $TOKEN"
```

In Kubernetes the chart wires the same variables via `values.yaml`:

```yaml
otel:
  enabled: true
  endpoint: "http://tempo.observability.svc.cluster.local:4318/v1/traces"
  headers: ""           # e.g. "Authorization=Bearer ${TEMPO_TOKEN}"
  serviceName: ""       # override resource service.name (default observability-mcp)
```

The chart automatically pins `service.version` to the image tag and
`service.instance.id` to the pod hostname.

## What gets traced

Out of the box (HTTP auto-instrumentation):

- Every `/api/*` route (sources CRUD, services, health, topology, policy, audit, products, etc.)
- Every `/mcp` Streamable HTTP request (initialize, tools/list, tools/call, etc.)
- Outgoing HTTP from connectors that use `node:http`/`fetch` (Prometheus,
  Loki, Tempo, Grafana, k8s API …) — captured as child spans so you see
  end-to-end latency from `/mcp` request → connector query → response.

Custom spans for analysis stages (anomaly detection, correlation, blast
radius) are not added in this iteration; they can land later as fine-grain
slicing if your post-mortems need per-stage timing.

## Pointing at a collector

### Direct OTLP collector

Any collector accepting OTLP/HTTP works (Tempo, Jaeger, Honeycomb, Grafana
Cloud, the OpenTelemetry Collector). Set `OMCP_OTEL_ENDPOINT` to its
`/v1/traces` URL.

### In-cluster Tempo (Kubernetes)

```yaml
# values.yaml
otel:
  enabled: true
  endpoint: "http://tempo.tempo.svc.cluster.local:4318/v1/traces"
```

Verify traces are flowing:

```bash
kubectl exec deploy/grafana -n monitoring -- \
  curl -s 'http://tempo:3200/api/search?tags=service.name=observability-mcp' \
  | jq '.traces | length'
```

## Failure mode

If `OMCP_OTEL_ENABLED=true` but the SDK init fails (collector
unreachable at start, missing dependency, etc.) the gateway logs a
single warning and continues without tracing. It never refuses to
boot because of a tracing misconfiguration.

```text
OTel self-tracing requested but init failed; gateway continues without tracing. <reason>
```

The standard `/metrics` Prometheus endpoint is unaffected — it remains
the authoritative health signal regardless of tracing state.

## Disabling

Unset `OMCP_OTEL_ENABLED` (or set it to `false`/`0`/`no`/`off`). No
exporter spins up, no OTel packages execute in the hot path. Cold-start
overhead drops to zero.

## Env reference

| Env | Default | Meaning |
|---|---|---|
| `OMCP_OTEL_ENABLED` | off | `true/1/yes/on` to enable |
| `OMCP_OTEL_ENDPOINT` | `http://localhost:4318/v1/traces` | OTLP/HTTP traces URL |
| `OMCP_OTEL_HEADERS` | — | `key1=val1,key2=val2` collector auth |
| `OMCP_OTEL_SERVICE_NAME` | `observability-mcp` | resource `service.name` |
| `OMCP_OTEL_SERVICE_VERSION` | from package | resource `service.version` |
