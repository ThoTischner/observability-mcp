# Observability-MCP Development Guide

## Docker-First Development

This project is fully containerized. **Never run `npm install` on the host machine.**

### Quick Start
```bash
docker compose --profile demo up --build
```

The demo stack brings up:
- a single-node **k3s** cluster (`rancher/k3s` in a privileged container)
- the three chaos-able example services (`api-gateway`, `payment-service`, `order-service`) as **Kubernetes Deployments** inside k3s (namespace `omcp-demo`)
- Prometheus, Loki, Promtail (on the docker-compose side) scraping k3s NodePorts and pod logs
- the MCP server with the `kubernetes` topology source pre-wired against k3s
- the autonomous agent

The same Deployments that emit metrics and logs are what shows up in the
topology graph — that is what lets the agent correlate a metric/log
anomaly with the underlying host via `get_blast_radius`.

Without `--profile demo`, only `mcp-server` runs — for production deployments where Prometheus/Loki are managed elsewhere.

### Rebuild a Single Service
```bash
docker-compose build mcp-server
docker-compose up -d mcp-server
```

### View Logs
```bash
docker compose logs -f agent          # Agent detection loop
docker compose logs -f mcp-server     # MCP server

# Example services run inside k3s now — use kubectl to follow their logs:
docker exec observability-mcp-k3s-1 \
  kubectl -n omcp-demo logs -f deployment/payment-service
```

### Run Unit Tests
```bash
docker run --rm -w /app -v "$(pwd)/mcp-server:/app" node:20-alpine \
  sh -c "npm install --silent && npx tsx --test src/analysis/*.test.ts"
```

### Trigger Chaos (Demo)
```bash
curl -X POST http://localhost:8081/chaos/high-cpu
curl -X POST http://localhost:8081/chaos/error-spike
curl -X POST http://localhost:8081/chaos/slow-responses
curl -X POST http://localhost:8081/chaos/memory-leak
curl -X POST http://localhost:8081/chaos/reset
```

Chaos modes are correlated: error-spike also increases CPU + latency + error logs. Memory-leak generates OOM warnings.

The chaos URLs above are unchanged after the services moved into k3s —
the compose file maps k3s NodePort 30080/30081/30082 onto host
8080/8081/8082, so existing scripts and demo videos keep working.

## Key Endpoints

| Service | URL | Purpose |
|---------|-----|---------|
| MCP Server | http://localhost:3000/mcp | MCP Streamable HTTP endpoint |
| Web UI | http://localhost:3000 | Management UI (Dashboard / Sources / Services / Health / Topology / Settings) |
| Health API | http://localhost:3000/api/health | Live health data for all services |
| Prometheus | http://localhost:9090 | Prometheus UI |
| Loki | http://localhost:3100 | Loki API |
| API Gateway | http://localhost:8080 | Example service (NodePort 30080 in k3s) |
| Payment Service | http://localhost:8081 | Example service, chaos target (NodePort 30081 in k3s) |
| Order Service | http://localhost:8082 | Example service (NodePort 30082 in k3s) |
| k3s (demo only) | https://k3s:6443 (in-network) | Single-node Kubernetes. Hosts the example services as Deployments in namespace `omcp-demo`. Kubeconfig in the `k3s-kubeconfig` named volume; mcp-server reads it via `KUBECONFIG=/k3s-kubeconfig/kubeconfig-internal.yaml`. |
| Ollama | host.docker.internal:11434 | LLM on Windows host |

## Project Structure

```
.
├── mcp-server/           # The product — MCP server + Web UI + analysis engine
│   ├── src/
│   │   ├── index.ts          # Express + MCP server + /api/* + /healthz + /readyz
│   │   ├── openapi.ts        # OpenAPI 3.1 spec served at /api/openapi.json
│   │   ├── types.ts          # Shared types
│   │   ├── connectors/       # Connector interface + builtin shims + PluginLoader
│   │   ├── sdk/              # Public SDK barrel + Zod manifest schema for plugins
│   │   ├── tools/            # 6 MCP tools + shared validation
│   │   ├── analysis/         # Anomaly detection, health scoring, correlation
│   │   ├── metrics/          # prom-client self-metrics + connector instrumentation
│   │   ├── config/           # sources.yaml loader (with ${VAR} substitution)
│   │   ├── util/             # sanitizeForLog, etc.
│   │   └── ui/index.html     # Single-file Web UI (Dashboard/Sources/Services/Health/Settings)
│   └── plugins/              # Filesystem connectors: prometheus/, loki/, kubernetes/
├── helm/observability-mcp/   # ArtifactHub-grade Helm chart (Deployment/HPA/NetworkPolicy/ServiceMonitor/test/values.schema)
├── examples/                 # Demo material — opt-in via `docker compose --profile demo`
│   ├── agent/                # Optional autonomous detection agent (uses Ollama)
│   ├── example-services/     # 3 chaos-able microservices, source code
│   ├── kubernetes/           # Demo workload manifests — Deployments + NodePort Services
│   ├── prometheus/           # Demo Prometheus config (scrapes k3s NodePorts)
│   ├── loki/                 # Demo Loki config
│   └── promtail/             # Demo log shipper (tails k3s pod logs)
└── docs/                     # configuration, auth-and-tls, plugin-architecture, airgapped-deployment, ...
```

## Demo data flow

```
docker-compose                                  k3s (in a privileged container)
──────────────                                  ────────────────────────────────
image-loader  ─builds & ctr-imports─────────►   containerd ──► example-service:demo
                                                                 ▼
prometheus  ◄──scrape via NodePort──── k3s ──── Deployments: api-gateway, payment-service, order-service
                                       │           (namespace omcp-demo, Pods 1× each)
loki  ◄────── push ──── promtail ◄───  │
                                       └─────── /var/log/pods (named volume) ──► promtail
mcp-server (kubernetes source) ─watch───┘
```

The chaos endpoints stay reachable on the host (`localhost:8080/8081/8082`)
because compose maps NodePort 30080/30081/30082 from the k3s container.
The agent never observes the move: it talks to MCP over stdio/HTTP and
the tool layer abstracts the underlying transport.

## Adding a New Connector

1. Create `mcp-server/src/connectors/<name>.ts`
2. Implement `ObservabilityConnector` interface:
   - `connect(config)`, `healthCheck()`, `disconnect()`
   - `getDefaultMetrics()` — return `MetricDefinition[]` with backend-specific queries
   - `getMetrics()` — return active metrics (user-configured or defaults)
   - `listServices()` — discover services from the backend
   - `queryMetrics?()` or `queryLogs?()` — implement what the backend supports
3. Register factory in `registry.ts`: `connectorFactories[type] = () => new MyConnector()`
4. Add source via Web UI or `config/sources.yaml`

Each connector owns its query language. Prometheus uses PromQL, Loki uses LogQL, a future InfluxDB connector would use Flux. The MCP tool layer stays agnostic.

## Configuration

All config lives in `mcp-server/config/sources.yaml` and is editable via the Web UI. Changes take effect immediately without restart.

- **Sources**: Backend connections with per-source metric definitions
- **Settings**: Agent check interval, Ollama URL/model, system prompt, default sensitivity
- **Health Thresholds**: Weights and good/warn/crit thresholds per metric type

## Agent Behavior

The agent (`examples/agent/src/index.ts`) is an optional demo client. The MCP server itself is LLM-agnostic.

It:
- Syncs settings from MCP server API each loop iteration
- Reconnects automatically if MCP server restarts
- Deduplicates anomalies (5 min TTL)
- Supports up to 3 rounds of LLM tool calling
- Falls back to raw anomaly output if Ollama is unavailable
