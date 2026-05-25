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

1. (Skippable with `--skip-chaos=true` for pure-topology questions
   that don't need a live failure.) `POST /chaos/reset` then
   `POST /chaos/<mode>` on the target service — induce a controlled
   incident. Chaos modes are intentionally correlated (errors also
   raise CPU and latency and emit error logs) so a competent SRE — or
   LLM — has multiple signals pointing at the same culprit.
2. Wait `CHAOS_WINDOW_MS` (default 45 s) so the anomaly is visible to
   Prometheus / Loki / the topology snapshot.
3. Send the prompt to Ollama. Default is the single-service RCA
   prompt; override with `--prompt="…"` for any other question
   (e.g. the cross-namespace blast-radius scenario above).
4. Tool surface depends on `--mode`:
   - `--mode=baseline` → 6 tools (no topology)
   - `--mode=topology` → 8 tools (incl. `get_topology`, `get_blast_radius`)
5. Multi-turn tool calling, up to `MAX_ROUNDS` (default 3). Each tool
   call goes through MCP `/mcp` Streamable HTTP. Tool results are fed
   back as `role: "tool"` messages.
6. When the model produces a final answer (no `tool_calls`), score:
   - **correctness**: by default the final answer must name
     `--target` AND mention an error / 5xx / error-spike signal.
     For non-RCA scenarios use `--correct-substrings=a,b,c` — the
     answer must contain all listed substrings (case-insensitive,
     dashes/underscores/spaces interchangeable).
   - **tokens**: total `prompt_eval_count + eval_count` summed across
     every Ollama call in the conversation. Captures per-round context
     growth, not just the last turn.

### Determinism: `temperature=0`

Every Ollama call passes `options: { temperature: 0, num_ctx: 8192 }`.
This is load-bearing — with default temperature (~0.8) the same model
on the same scenario produced wildly different tool-use patterns
(zero tool calls vs. consistent tool calls) across iterations.
`temperature=0` makes the experiment reproducible.

### System prompt

The system prompt explicitly demands tool invocation via the
function-calling API (not as text in `content`) and lists the
currently available tools by name. Earlier softer prompts ("use tools
before guessing") let the model rationalise skipping tool calls;
the current prompt does not give it that out.

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

### Headline

**On a real Kubernetes-platform-team question — "if this node is taken
down for maintenance, which pods go offline?" — the baseline agent
achieved 0/10 accuracy and hallucinated wrong entities with confidence
("prometheus, loki, kubernetes" listed as pods). The same model with
`get_blast_radius` available achieved 10/10, deterministically, with
the exact correct co-tenant list including kube-system pods the
baseline literally cannot know about. Topology tools turn an impossible
question into a trivial one — not "marginally helpful", possible vs
impossible.**

### Three scenarios, three different stories

Same harness, same model, same demo workload. Only the question and
the tool set change. Raw JSON evidence under
[`benchmark-results/`](benchmark-results/).

| scenario                                  | model        | n  | baseline acc | topology acc | tokens (B → T) | meaningful winner |
|-------------------------------------------|--------------|----|--------------|--------------|---------------|-------------------|
| RCA — single failing service              | llama3.1:8b  | 10 | 10/10        | 10/10        | 3,031 → 3,766 (+24%) | **baseline** (cheaper, same accuracy) |
| RCA — single failing service              | qwen2.5:7b   | 10 | 10/10\*      | 10/10        | 7,445 → 9,429 (+27%) | **baseline** (cheaper, same accuracy) |
| Blast radius — in-namespace               | llama3.1:8b  | 5  | 5/5†         | 5/5          | 3,467 → 3,901 (+13%) | **topology** (1 round vs 2, deterministic) |
| Blast radius — cross-namespace (kube-sys) | llama3.1:8b  | 10 | **0/10**     | **10/10**    | 2,984 → 5,704 (+91%) | **topology** (possible vs impossible) |
| Blast radius — cross-namespace (kube-sys) | qwen2.5:7b   | 10 | 0/10         | 1/10‡        | 8,403 → 9,934 (+18%) | **topology** (any chance vs none) |

\* lenient scorer (the strict regex misses `error_rate` with underscore)
† baseline correct by namespace-inference, would fail in any multi-node cluster
‡ qwen kept picking `get_topology` (returns the whole graph and overwhelms it) instead of the focused `get_blast_radius`; a tool-description tweak would close that

### The single-failing-service RCA story (rows 1–2)

> "Production is reporting elevated 5xx errors at the API gateway over
> the last few minutes. Identify the single root-cause service and the
> failing signal."

Both arms hit perfect accuracy. The chaos targets one leaf service
whose error rate is directly visible in metrics and logs;
`detect_anomalies` is enough. Topology tools add ~25% prompt overhead
for zero accuracy gain because the model doesn't even reference them
in answers — it solves the question with `detect_anomalies` alone.

**Honest read**: use of topology tools here is pure cost. The product
positioning has to acknowledge this rather than pretend topology helps
everywhere.

### The in-namespace blast-radius story (row 3)

> "Pod payment-service-578bfd9fd9-5bh5w is being decommissioned with
> its node. Which other application services would be impacted?"

Both arms 5/5 — but for very different reasons.

**Baseline** called `list_services`, saw three services in the
namespace, **assumed** namespace = same node. That happens to be right
in our single-node k3s demo. In any multi-node Kubernetes cluster this
inference would silently include or exclude wrong services. Answers
also varied across iterations.

**Topology** called `get_blast_radius`, got the actual co-tenant list,
answered identically across all 5 iterations. **Same answer, but
deterministically and correctly by construction rather than by
namespace-inference coincidence.** Also 33% faster end-to-end despite
+13% token overhead — one tool call vs two.

### The cross-namespace blast-radius story (rows 4–5) — the headline

> "List EVERY other pod on the same node — application AND
> infrastructure pods — that would also go offline."

The question explicitly demands kube-system pods. `list_services`
only returns the 3 omcp-demo application services; nothing in the
baseline tool set can surface coredns / local-path-provisioner.

**llama3.1:8b baseline, all 10 iterations, identical wrong answer:**

```
The pods that would also go offline are:
* prometheus
* loki
* kubernetes
```

Those are observability-mcp's source backends, not Kubernetes pods.
The model had no relevant tool, so it confidently hallucinated entities
of the wrong type. **This is the failure mode real platform teams would
silently ship to production with the wrong tooling.**

**llama3.1:8b topology, all 10 iterations, identical correct answer:**

```
The other pods on the same node that would also go offline are:
* coredns-56f6fc8fd7-pxwb8
* local-path-provisioner-5cf85fd84d-pmx2g
* api-gateway-5cc97ffcc8-m78p9
* order-service-5df8bcd858-9mdjp
```

This is the slam-dunk evidence: 0/10 → 10/10 on the same model. Not
a token saving, not a marginal improvement — the **difference between
possible and impossible**.

### Methodology updates that mattered

The first row published in #212 used a vague system prompt and default
Ollama parameters. With `temperature=0` and an explicit "you MUST use
the function-calling API to invoke tools — do NOT describe tool use in
text" system prompt, llama3.1:8b baseline accuracy on the
single-service RCA scenario went **40% → 100%** on the same model.
**Methodology fixed more than model size did.** Numbers above were all
captured with the corrected harness.

### What we're not claiming

- We are **not** claiming topology helps universally. It demonstrably
  doesn't on single-service RCA — that's row 1–2.
- We are **not** comparing against Causely's published benchmark
  directly. Different workload, different LLM, different scoring rule.
- We are **not** publishing numbers from the Astronomy Shop hybrid
  yet — those rows are still in the queue. The k3s-demo numbers above
  are tighter because of the chaos repeatability.

### Reproduce

```bash
docker compose --profile demo up -d
ollama pull llama3.1:8b

# Scenario 1: single-failing-service RCA
node scripts/benchmark-rca.mjs --mode=baseline --iterations=10 --model=llama3.1:8b > baseline.json
node scripts/benchmark-rca.mjs --mode=topology --iterations=10 --model=llama3.1:8b > topology.json

# Scenario 3: cross-namespace blast radius (the killer)
POD=$(docker exec observability-mcp-k3s-1 kubectl get pod -n omcp-demo -l app=payment-service -o jsonpath='{.items[0].metadata.name}')
PROMPT="The application pod ${POD} (namespace omcp-demo) is being decommissioned with its underlying Kubernetes node. List EVERY other pod on the same node — application AND infrastructure pods — that would also go offline. Output the pod or service names only, one per line."

node scripts/benchmark-rca.mjs --mode=baseline --skip-chaos=true --iterations=10 \
  --model=llama3.1:8b --prompt="$PROMPT" \
  --correct-substrings="api-gateway,order-service,coredns" > br-baseline.json

node scripts/benchmark-rca.mjs --mode=topology --skip-chaos=true --iterations=10 \
  --model=llama3.1:8b --prompt="$PROMPT" \
  --correct-substrings="api-gateway,order-service,coredns" > br-topology.json
```

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
