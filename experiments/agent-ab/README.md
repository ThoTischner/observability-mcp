# B1 — Agent A/B experiment

Does the observability-mcp tool surface measurably help an AI agent
resolve an incident versus the same agent with only raw
Prometheus/Loki query tools? This is the thesis test from
[`docs/differentiation-plan.md`](../../docs/differentiation-plan.md).
It runs **before** heavy investment in the analysis engine, on
purpose: a negative result is a valid, reportable outcome.

## What is controlled

Identical across both arms — only the **tool surface** differs:

| Held constant | Value |
|---|---|
| Model | `$OLLAMA_MODEL` (default `llama3.2:3b`) |
| Temperature | `0` |
| System prompt | identical SRE prompt |
| User question | identical incident prompt |
| Tool-call budget | `$MAX_ROUNDS` (default 5) |
| Backends / data | same demo stack, same chaos state (`error-spike` on payment-service), runs back-to-back |

| Arm | Tools given to the agent |
|---|---|
| **A · raw** | `prometheus_query`, `loki_query` only — no discovery, no anomaly detection, no health scoring, no correlation |
| **B · obs-mcp** | the observability-mcp curated MCP tools (`list_services`, `detect_anomalies`, `get_service_health`, `query_metrics`, `query_logs`, `list_sources`) |

## Measured

Tokens (prompt+generation, summed over all model calls), tool-call
rounds, distinct tools used, wall-clock, and a **deterministic
correctness check**: the final answer must name `payment-service`
*and* a real symptom (error/latency/cpu/oom/…). Ground truth is fixed
by the deterministic chaos scenario.

## Run

Stack must be up (`docker compose --profile demo up -d`). Then,
Docker-first, zero npm deps:

```bash
docker run --rm --network host -v "$PWD:/w" -w /w node:20-alpine \
  node experiments/agent-ab/run.mjs
```

Outputs `results/<ts>.json` and a regenerated `results/latest.md`.

## Honest caveats

- A small local model (`llama3.2:3b`) is weak in absolute terms. That
  is fine: both arms use the **same** model, so the **delta** isolates
  the tool surface — which is exactly the thesis under test. Absolute
  answer quality is not the claim.
- Single scenario, single model → directional signal, not a benchmark.
  Repeat across scenarios/models before drawing strong conclusions.
- Arm A is a fair "no gateway" baseline (the raw APIs an agent would
  otherwise call), not a strawman: it has full PromQL/LogQL power.
- If Arm B does **not** win clearly, that finding goes in the plan and
  reprioritises the roadmap. The experiment is allowed to fail.
