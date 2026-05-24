# Benchmark: does topology context reduce token spend on RCA?

This benchmark measures one question in a controlled way:

> When an LLM has to identify the single root-cause service from a live
> incident, does giving it `get_topology` + `get_blast_radius` change
> how many tokens it burns and how often it gets the right answer?

We measure two arms — **baseline** (6 MCP tools: metrics, logs, anomaly
detection, health, service discovery) and **topology** (same 6 plus
`get_topology` and `get_blast_radius`). Everything else is identical:
same prompt, same model, same chaos injection, same chat-loop budget.

The script lives at `scripts/benchmark-rca.mjs`. Both arms run against
the bundled k3s demo (`docker compose --profile demo up`). Astronomy
Shop integration is documented separately below as an external overlay
because shipping a 15-service OTel demo in this repo would dwarf the
rest of the stack.

> **Honest scope.** This is not a published score-card claim. Numbers
> below come from one author's WSL2 + Ollama setup. The point of
> shipping the harness is so anyone can re-run it on their own setup
> and verify or refute. The methodology, the prompt, the scoring rule,
> and the demo workload are all in this repo at the SHA below — no
> proprietary judge model, no hidden prompt tuning.

## Methodology

Per iteration:

1. `POST /chaos/reset` on `payment-service` — clear any prior chaos.
2. `POST /chaos/error-spike` on `payment-service` — induce a controlled
   5xx storm. The chaos modes are intentionally correlated (errors also
   raise CPU and latency and emit error logs) so a competent SRE — or
   LLM — has multiple signals pointing at the same culprit.
3. Wait `CHAOS_WINDOW_MS` (default 45 s) so the anomaly is visible to
   Prometheus / Loki / the topology snapshot.
4. Send the **fixed RCA prompt** to Ollama:

   > "Production is reporting elevated 5xx errors at the API gateway
   > over the last few minutes. Your job: identify the single
   > root-cause service and the failing signal, in two sentences. Use
   > the available tools."

5. Tool surface depends on `--mode`:
   - `--mode=baseline` → 6 tools (no topology)
   - `--mode=topology` → 8 tools (incl. `get_topology`, `get_blast_radius`)
6. Multi-turn tool calling, up to `MAX_ROUNDS` (default 3). Each tool
   call goes through MCP `/mcp` Streamable HTTP. Tool results are fed
   back as `role: "tool"` messages.
7. When the model produces a final answer (no `tool_calls`), score:
   - **correctness**: final answer must name `payment-service` AND
     mention an error / 5xx / error-spike signal.
   - **tokens**: total `prompt_eval_count + eval_count` summed across
     every Ollama call in the conversation. Captures per-round context
     growth, not just the last turn.

### Why crude substring matching for correctness

LLM-as-judge would add another model dependency we'd have to defend.
Substring matching is hostile to subtle wins — the model might be
*right* and phrased it differently — but it's transparent, reproducible
without an API key, and impossible to game by prompt-engineering the
final answer. Refining the scorer would land as a follow-up.

### Why total tokens, not just prompt tokens

Topology tools are extra context the model has to read on every turn,
so their cost shows up in `prompt_eval_count` of later rounds. But
they also (the hypothesis) let the model finish in fewer rounds and
emit a shorter final answer. The net is what matters, not either side
in isolation.

## Running it

Pick one of the two demos and run the harness against it.

### Against the k3s demo (3 services + chaos)

```bash
docker compose --profile demo up -d
curl http://localhost:8081/chaos/reset
ollama pull llama3.1:8b
node scripts/benchmark-rca.mjs --mode=baseline --iterations=5 > baseline.json
node scripts/benchmark-rca.mjs --mode=topology --iterations=5 > topology.json
```

### Against Astronomy Shop (~23 services, OTel-native)

```bash
ollama pull llama3.1:8b
make benchmark-up
make benchmark-run ITERATIONS=5
# results land in .benchmark/results/{baseline,topology}.json
make benchmark-down
```

Under the hood `benchmark-run` invokes the harness with
`--chaos-driver=feature-flag --target=paymentservice`, toggling
Astronomy Shop's `paymentServiceFailure` flag via flagd between
iterations.

Defaults assume:

| flag        | default                                    |
|-------------|--------------------------------------------|
| `--mcp`     | `http://localhost:3000/mcp`                |
| `--ollama`  | `http://localhost:11434`                   |
| `--model`   | `llama3.1:8b`                              |
| `--chaos`   | `http://localhost:8081`                    |
| `--target`  | `payment-service`                          |
| `--window`  | `45000` (ms to wait after chaos trigger)   |
| `--rounds`  | `3` (max tool-calling rounds)              |

For a head-to-head with the same chaos pattern but a different
target / model, pass the appropriate flags through.

### Output

The script prints a JSON object per arm with totals and per-iteration
detail:

```json
{
  "mode": "topology",
  "model": "llama3.1:8b",
  "iterations": 5,
  "tools": ["list_sources","list_services","query_metrics","query_logs",
            "get_service_health","detect_anomalies",
            "get_topology","get_blast_radius"],
  "totals": {
    "tokens": 0,
    "meanTokensPerIteration": 0,
    "correctIterations": 0,
    "accuracy": 0,
    "meanRounds": 0,
    "meanDurationMs": 0
  },
  "iterations_detail": [...]
}
```

Comparing the two arms is a simple `jq` diff:

```bash
jq '.totals' baseline.json topology.json
```

## Results

Numbers are populated *only when run with Ollama up*. We deliberately
do not commit synthetic numbers — the point of the harness is that
anyone can reproduce a real one. Append your run to this table.

| run date    | model           | iterations | mode      | mean tokens / iter | accuracy | mean rounds | mean duration |
|-------------|-----------------|------------|-----------|---------------------|----------|-------------|----------------|
| _example_   | llama3.1:8b     | 5          | baseline  | TBD                 | TBD      | TBD         | TBD            |
| _example_   | llama3.1:8b     | 5          | topology  | TBD                 | TBD      | TBD         | TBD            |

Open a PR adding a row when you run a head-to-head.

## Two demos, two purposes

| profile                         | workload                          | what it's good for                                   |
|---------------------------------|-----------------------------------|------------------------------------------------------|
| `docker compose --profile demo` | 3 chaos services in k3s           | onboarding, fast feedback, k8s-topology A/B          |
| `make benchmark-up`             | OpenTelemetry Astronomy Shop (~23 services) + our Tempo + OTel bridge | credible service-graph A/B, real OTel telemetry |

The `demo` profile is for showing the product in 10 seconds. The
`benchmark` profile is for producing numbers that hold up next to peer
products. Both run side-by-side using the same `mcp-server`; pick
whichever fits the question.

The `benchmark` profile does **not** bundle Astronomy Shop in our
compose. `make benchmark-up` clones the upstream OpenTelemetry Demo
into `.benchmark/opentelemetry-demo/` (shallow) on first run and
orchestrates both stacks: ours brings up Tempo + an OTel collector
bridge under `--profile benchmark`; upstream runs in its own compose
project (`-p otel-demo`) with `OTEL_COLLECTOR_HOST` repointed at our
bridge so traces land in our Tempo. See
[examples/benchmark/README.md](../examples/benchmark/README.md) for the
exact commands and caveats.

### Why this split

- Upstream's compose is ~23 services + Prometheus + Jaeger + Grafana
  + OpenSearch. Forking or vendoring it means tracking their releases
  forever. Cloning on-demand is one git pull less to forget.
- Our `mcp-server` is *the* thing under test — keeping it on our side
  of the boundary means the benchmark surface is unchanged regardless
  of which workload we point at.
- The k3s `demo` profile is pedagogically valuable (you can see exactly
  what 3 services + chaos do); the Astronomy Shop profile is too dense
  to teach with. Keeping both keeps both audiences.

## Reproducibility checklist

If you publish numbers, include in your write-up:

- the exact SHA of this repo (so the prompt, the scoring rule, the
  tool surface, and the chaos pattern are pinned)
- the Ollama model name + tag
- iteration count, max rounds, chaos window
- the full JSON output of both arms

Without those four, a token-saving claim is unverifiable.

## See also

- `docs/topology-vocabulary.md` — the contract the topology tools
  operate on. Affects what `get_topology` returns and which edges
  `get_blast_radius` walks.
- `docs/kubernetes.md` — what the bundled kubernetes connector emits.
- `examples/benchmark/README.md` — Astronomy Shop overlay recipe.
