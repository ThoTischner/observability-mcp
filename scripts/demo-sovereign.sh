#!/usr/bin/env bash
# Sovereign quickstart — one command, fully on-prem, zero external calls.
#
# Brings up the demo stack, injects a real incident, and shows the contrast
# an AI agent sees WITHOUT vs WITH the analysis layer:
#   - RAW   : a Prometheus query returns a wall of numbers, no verdict.
#   - ANALYZED: /api/health returns a scored verdict that pinpoints the
#               failing service and why.
#
# The proof is deterministic and needs no LLM. The optional `agent` service
# in the demo profile consumes exactly this analyzed layer using a LOCAL
# model (Ollama on host.docker.internal) — nothing leaves the host. The
# "no data egress" guarantee is enforced separately (`make test-offline`,
# src/net/egress-policy.test.ts).
set -euo pipefail

CHAOS="http://localhost:8081"
MCP="http://localhost:3000"
PROM="http://localhost:9090"
KEEP_UP="${KEEP_UP:-0}"

say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

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
curl -fsS "$MCP/api/health" | (jq '[.[] | {service, status, score}]' 2>/dev/null || cat)

say "Injecting a real incident: memory leak on payment-service"
for _ in 1 2 3 4; do curl -fsS -X POST "$CHAOS/chaos/memory-leak" >/dev/null; sleep 30; done

say "RAW — what an agent gets WITHOUT the analysis layer (Prometheus, no verdict)"
curl -fsS "$PROM/api/v1/query?query=service_memory_usage_bytes%7Bjob%3D%22payment-service%22%7D" \
  | (jq -c '.data.result[0:3]' 2>/dev/null || cat)
echo "  ^ raw numbers. No 'is this bad?', no culprit, no mechanism."

say "ANALYZED — what the agent gets WITH the layer (scored verdict + culprit)"
curl -fsS "$MCP/api/health/payment-service" \
  | (jq '{service, status, score, signals, anomalies}' 2>/dev/null || cat)
curl -fsS "$MCP/api/health" \
  | (jq '[.[] | select(.status != "healthy") | {service, status, score}]' 2>/dev/null || cat)

say "Sovereign summary"
cat <<'EOF'
- Everything above ran on your machine. No external API, no telemetry.
- The optional `agent` service reasons over the ANALYZED layer using a
  LOCAL model (Ollama, host.docker.internal:11434) — set OLLAMA_MODEL.
- No-data-egress is enforced & tested: `make test-offline`.
- Reproduce or embed the engine without the gateway:
    import { analyzeMetric } from "@thotischner/observability-mcp/analysis";
EOF
