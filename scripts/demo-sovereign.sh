#!/usr/bin/env bash
# Sovereign quickstart — one command, fully on-prem, zero external calls.
#
# Brings up the demo stack, injects a real incident, and shows the contrast
# an AI agent sees WITHOUT vs WITH the analysis layer:
#   - RAW   : a Prometheus query returns a wall of numbers, no verdict.
#   - ANALYZED: /api/health returns a scored verdict that drops the failing
#               service out of "healthy" and surfaces correlated signals.
#
# The proof is deterministic and needs no LLM. The optional `agent` service
# in the demo profile consumes exactly this analyzed layer using a LOCAL
# model (Ollama on host.docker.internal) — nothing leaves the host. The
# "no data egress" guarantee is enforced separately (`make test-offline`,
# src/net/egress-policy.test.ts).
#
# Self-verifying: if the analyzed layer does NOT flag the injected incident,
# the script exits non-zero (a demo must never silently show "all healthy").
set -euo pipefail

CHAOS="http://localhost:8081"
MCP="http://localhost:3000"
PROM="http://localhost:9090"
KEEP_UP="${KEEP_UP:-0}"

say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
have_jq() { command -v jq >/dev/null 2>&1; }

cleanup() {
  curl -fsS -X POST "$CHAOS/chaos/reset" >/dev/null 2>&1 || true
  if [ "$KEEP_UP" != "1" ]; then
    say "Tearing down (set KEEP_UP=1 to keep the stack)"
    docker compose --profile demo down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

say "Starting the full stack on-prem (Prometheus + Loki + services + MCP)"
docker compose --profile demo up -d --build --wait

say "Waiting for the MCP server"
for _ in $(seq 1 30); do
  curl -fsS "$MCP/healthz" >/dev/null 2>&1 && break || sleep 2
done
curl -fsS "$MCP/healthz" >/dev/null

say "Baseline — analyzed health of all services (no incident yet)"
curl -fsS "$MCP/api/health" | (have_jq && jq '[.[] | {service, status, score}]' || cat)

# error-spike is the canonical correlated incident: it drives error rate,
# CPU and latency together, so the analyzed layer must clearly flag it.
say "Injecting a real incident: error-spike on payment-service"
curl -fsS -X POST "$CHAOS/chaos/error-spike" >/dev/null
echo "waiting ~75s for the signal to build in Prometheus/Loki..."
for _ in 1 2 3 4 5; do curl -fsS -X POST "$CHAOS/chaos/error-spike" >/dev/null; sleep 15; done

say "RAW — what an agent gets WITHOUT the analysis layer (Prometheus, no verdict)"
curl -fsS "$PROM/api/v1/query?query=rate%28http_requests_total%7Bjob%3D%22payment-service%22%7D%5B1m%5D%29" \
  | (have_jq && jq -c '.data.result[0:4]' || cat)
echo "  ^ raw numbers. No 'is this bad?', no culprit, no mechanism."

say "ANALYZED — what the agent gets WITH the layer (scored verdict + culprit)"
PAY=$(curl -fsS "$MCP/api/health/payment-service")
echo "$PAY" | (have_jq && jq '{service, status, score, signals, anomalies, correlations}' || cat)
say "ANALYZED — services no longer healthy"
curl -fsS "$MCP/api/health" \
  | (have_jq && jq '[.[] | select(.status != "healthy") | {service, status, score}]' || cat)

# --- Self-verification: the analyzed layer MUST have caught it ----------
status=$(echo "$PAY" | (have_jq && jq -r '.status' || sed -n 's/.*"status":"\([a-z]*\)".*/\1/p' | head -1))
score=$(echo "$PAY" | (have_jq && jq -r '.score' || sed -n 's/.*"score":\([0-9]*\).*/\1/p' | head -1))
echo "payment-service verdict: status=${status:-?} score=${score:-?}"
if [ "${status:-healthy}" = "healthy" ]; then
  echo "FAIL: analyzed layer did not flag the injected incident (still healthy)" >&2
  exit 1
fi
echo "PASS: the analyzed layer flagged payment-service as ${status} — raw Prometheus did not."

say "Sovereign summary"
cat <<'EOF'
- Everything above ran on your machine. No external API, no telemetry.
- The optional `agent` service reasons over the ANALYZED layer using a
  LOCAL model (Ollama, host.docker.internal:11434) — set OLLAMA_MODEL.
- No-data-egress is enforced & tested: `make test-offline`.
- Reproduce or embed the engine without the gateway:
    import { analyzeMetric } from "@thotischner/observability-mcp/analysis";
EOF
