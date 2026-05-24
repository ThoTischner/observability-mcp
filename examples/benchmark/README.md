# Benchmark overlay — pointing the harness at the OpenTelemetry Demo

The benchmark script at `scripts/benchmark-rca.mjs` (see
`docs/benchmark-astronomy-shop.md` for the methodology) is
backend-agnostic: it asks MCP, MCP asks whichever
Prometheus/Loki/Tempo the operator has wired up. So pointing the same
harness at the OpenTelemetry Demo ("Astronomy Shop") is a matter of
running their stack alongside ours and re-pointing our MCP sources.

This file is a recipe, not an integrated profile, because the OTel
Demo is ~15 services / ~4 GB of images — too heavy to belong in this
repo's compose stack.

## Recipe

```bash
# 1. Pull and start Astronomy Shop in a separate compose project
git clone --depth=1 https://github.com/open-telemetry/opentelemetry-demo /tmp/otel-demo
cd /tmp/otel-demo
docker compose up -d

# 2. Verify their Prometheus + Grafana are up
curl http://localhost:9090/api/v1/status/runtimeinfo   # Astronomy Shop's Prometheus
curl http://localhost:8080                              # the demo frontend

# 3. Point this repo's MCP server at their backends instead of ours
#    Use the Web UI at http://localhost:3000 → Sources, or edit
#    mcp-server/config/sources.yaml:
#
#    sources:
#      - name: prom-otel-demo
#        type: prometheus
#        url: http://host.docker.internal:9090
#      - name: tempo-otel-demo
#        type: tempo
#        url: http://host.docker.internal:3200
#
# 4. Trigger a real incident pattern in the Astronomy Shop. They
#    expose a feature flags page at http://localhost:8080/feature
#    — enable e.g. `paymentServiceFailure` or `cartServiceFailure`
#    for a controlled error spike.

# 5. Run the benchmark, pointing chaos at the feature-flag toggle
#    instead of our /chaos/error-spike endpoint:
cd <this repo>
node scripts/benchmark-rca.mjs \
  --mode=baseline \
  --target=paymentservice \
  --chaos=http://localhost:8080/api/feature \
  --iterations=5
```

The `--target` flag changes which service name the correctness scorer
looks for. The chaos trigger URL is currently hard-coded to
`POST <chaos>/chaos/error-spike`; if you want to drive feature flags
instead, that's a one-line patch in `chaosTrigger()`. We deliberately
have not generalised it because the OTel Demo chaos surface is wholly
different from our `/chaos/*` endpoints — coupling them would obscure
which workload produced which numbers.

## Caveats

- Port `8080` collides between Astronomy Shop's frontend and our
  api-gateway NodePort. Stop our demo (`docker compose stop`) first
  or remap.
- Astronomy Shop's Prometheus runs on its own scrape interval; allow
  a longer `--window` (e.g. 90 000) so the topology snapshot has
  caught the failure.
- Astronomy Shop ships Jaeger, not Tempo, by default. The Tempo
  connector won't have data — switch their `tracing-backend` flag to
  Tempo or skip the `CALLS`-edge half of the topology test.
