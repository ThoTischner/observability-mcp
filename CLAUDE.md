# Observability-MCP Development Guide

## Docker-First Development

This project is fully containerized. **Never run `npm install` on the host machine.**

### Quick Start
```bash
docker-compose up --build
```

All 8 containers start with health checks. Services generate traffic automatically.

### Rebuild a Single Service
```bash
docker-compose build mcp-server
docker-compose up -d mcp-server
```

### View Logs
```bash
docker-compose logs -f agent          # Agent detection loop
docker-compose logs -f mcp-server     # MCP server
docker-compose logs -f payment-service # Example service
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

## Key Endpoints

| Service | URL | Purpose |
|---------|-----|---------|
| MCP Server | http://localhost:3000/mcp | MCP Streamable HTTP endpoint |
| Web UI | http://localhost:3000 | Management UI (5 pages) |
| Health API | http://localhost:3000/api/health | Live health data for all services |
| Prometheus | http://localhost:9090 | Prometheus UI |
| Loki | http://localhost:3100 | Loki API |
| API Gateway | http://localhost:8080 | Example service |
| Payment Service | http://localhost:8081 | Example service (chaos target) |
| Order Service | http://localhost:8082 | Example service |
| Ollama | host.docker.internal:11434 | LLM on Windows host |

## Project Structure

```
mcp-server/src/
├── index.ts              # Express + MCP server + API endpoints
├── types.ts              # Shared type definitions
├── connectors/
│   ├── interface.ts      # ObservabilityConnector interface (implement this for new backends)
│   ├── registry.ts       # Connector lifecycle management
│   ├── prometheus.ts     # Prometheus connector (PromQL, default metrics)
│   └── loki.ts           # Loki connector (LogQL)
├── tools/
│   ├── list-sources.ts   # MCP tool: list backends
│   ├── list-services.ts  # MCP tool: discover services
│   ├── query-metrics.ts  # MCP tool: query metrics (with validation)
│   ├── query-logs.ts     # MCP tool: query logs (with validation)
│   ├── get-service-health.ts  # MCP tool: aggregated health score
│   ├── detect-anomalies.ts    # MCP tool: cross-signal anomaly detection
│   └── validation.ts     # Shared input validation helpers
├── analysis/
│   ├── anomaly.ts        # Z-score anomaly detection
│   ├── health.ts         # Health scoring (configurable thresholds)
│   └── correlator.ts     # Cross-signal correlation
├── config/
│   └── loader.ts         # YAML config loader with defaults
└── ui/
    └── index.html        # Single-file Web UI (Dashboard, Sources, Services, Health, Settings)
```

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

The agent (`agent/src/index.ts`):
- Syncs settings from MCP server API each loop iteration
- Reconnects automatically if MCP server restarts
- Deduplicates anomalies (5 min TTL)
- Supports up to 3 rounds of LLM tool calling
- Falls back to raw anomaly output if Ollama is unavailable
