# Benchmark profile — OpenTelemetry Demo (Astronomy Shop) hybrid

The `benchmark` compose profile and the `make benchmark-up/down/run`
targets stand up a hybrid stack where:

- **Our side** (this repo, `--profile benchmark`) brings up
  - `tempo` — single-binary, metrics-generator enabled
  - `otel-collector-bridge` — OTLP gRPC/HTTP receiver that forwards
    traces to Tempo and exposes metrics for Prometheus to scrape
  - the always-on `mcp-server`
- **Upstream side** (cloned from <https://github.com/open-telemetry/opentelemetry-demo>)
  brings up the full Astronomy Shop workload (~23 services). Upstream's
  own Prometheus + Jaeger + Grafana + OpenSearch stay in place — they
  power the Astronomy Shop UI — but service telemetry is *also* pushed
  to our bridge via `OTEL_COLLECTOR_HOST=otel-collector-bridge`.

We don't fork or vendor the upstream stack: `make benchmark-up` clones
the upstream repo (shallow) into `.benchmark/opentelemetry-demo/` on
first run, then re-uses it.

## One-shot

```bash
make benchmark-up         # boots ours + upstream, joins networks
make benchmark-run        # runs harness baseline + topology, writes JSON
make benchmark-down       # tears down both
```

`benchmark-run` defaults to 5 iterations per arm. Override:

```bash
make benchmark-run ITERATIONS=10
```

Results land in `.benchmark/results/{baseline,topology}.json`.

## Manual steps

If you want to drive the pieces yourself:

```bash
# 1. Clone upstream demo (or `make benchmark-deps`)
git clone --depth=1 https://github.com/open-telemetry/opentelemetry-demo \
  .benchmark/opentelemetry-demo

# 2. Start our side (Tempo + bridge + mcp-server)
docker compose --profile benchmark up -d --wait

# 3. Start upstream Astronomy Shop, repointing telemetry at our bridge
cd .benchmark/opentelemetry-demo
OTEL_COLLECTOR_HOST=otel-collector-bridge docker compose -p otel-demo up -d
cd -

# 4. Join the upstream network to ours so the bridge resolves
docker network connect observability_observability otel-demo_default

# 5. Point mcp-server at the benchmark sources (Web UI Sources tab,
#    or mount examples/benchmark/sources.yaml as
#    mcp-server/config/sources.yaml)

# 6. Run the harness
node scripts/benchmark-rca.mjs \
  --mode=topology \
  --chaos-driver=feature-flag \
  --target=paymentservice \
  --iterations=5 > /tmp/topology.json
```

## How the chaos driver works

In `--chaos-driver=feature-flag` mode, the harness toggles an Astronomy
Shop feature flag via flagd's HTTP API. Default flag:
`paymentServiceFailure`. Override with `--flag=<name>` and
`--flag-variant=<variant>`.

`reset()` sets the variant to `off`; `trigger()` sets it to `on`.
Between iterations the harness waits `--window=<ms>` (default 45 000) so
the failure is visible to Prometheus + Tempo's service-graph before the
LLM is asked.

If `flagd` is unreachable at `--flagd=<url>`, the harness logs a warning
and continues — the iteration will simply not produce a fault, which
shows up as poor accuracy. That's a deliberate failure-visible mode, not
a silent skip.

## What `--mode=topology` actually adds

Same six metrics/logs tools as `--mode=baseline`, plus:

- `get_topology` — merged graph from every topology-capable connector
- `get_blast_radius` — host-pivot walk over `RUNS_ON`

On the benchmark stack the topology graph is populated entirely from
**Tempo `CALLS` edges**: services exchanging spans across the e-commerce
flow (`frontend → cart → checkout → payment → currency → …`). There's
no Kubernetes connector active in this profile — Astronomy Shop runs in
Docker, not k3s — so the topology arm is testing whether *service-graph*
context helps RCA, not infrastructure topology.

## Caveats

- **Port 8080** is used by the Astronomy Shop frontend AND our k3s demo
  api-gateway NodePort. The benchmark profile leaves our `demo`
  profile down, so there's no collision in practice — but if you run
  both at once, the second `up` will fail. Stop one first.
- **Logs**: Astronomy Shop ships OpenSearch for logs, not Loki. The
  bundled `sources.yaml` for this profile omits Loki entirely. Logs
  queries against `mcp-server` will report "no logs backend
  configured". An OpenSearch connector is a separate piece of work.
- **First-time pull**: ~4 GB of upstream images. Plan accordingly.
- **Network connect** is idempotent but adds a noisy "already
  exists" line on subsequent `make benchmark-up`. Ignore.
