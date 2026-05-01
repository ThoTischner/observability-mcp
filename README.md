<div align="center">

# observability-mcp

**The unified observability gateway for AI agents.**

One MCP server that connects to any observability backend through pluggable connectors,
normalizes the data, adds intelligent analysis, and provides a web UI for configuration.

*What Grafana did for dashboards, we do for AI agents.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@thotischner/observability-mcp?logo=npm)](https://www.npmjs.com/package/@thotischner/observability-mcp)
[![GHCR](https://img.shields.io/badge/ghcr.io-observability--mcp-2496ED?logo=docker&logoColor=white)](https://github.com/ThoTischner/observability-mcp/pkgs/container/observability-mcp)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP SDK](https://img.shields.io/badge/MCP_SDK-1.12-orange)](https://modelcontextprotocol.io)

![Web UI Dashboard](docs/dashboard.png)

</div>

---

## Try it in 10 seconds

```bash
npx @thotischner/observability-mcp
# then open http://localhost:3000
```

The server starts with **zero sources**. Add Prometheus/Loki via Web UI or `PROMETHEUS_URL`/`LOKI_URL` env vars. See [Installation](#installation) for Docker and other options.

## Why?

Every observability vendor ships its own MCP server — Prometheus, Grafana, Datadog, Elastic, each siloed. AI agents that need to reason across systems must juggle N separate servers. There is no unified abstraction layer.

**observability-mcp** is that layer.

## Features

- **Unified Gateway** — Single MCP endpoint for all your observability backends. Prometheus, Loki, and any future connector through one interface.
- **Cross-Signal Analysis** — Correlates metrics and logs automatically. Detects patterns like "CPU spike + error logs = resource saturation" across signals.
- **LLM Incident Analysis** — Agent detects anomalies via z-score analysis, then uses Ollama for multi-turn root cause analysis with severity classification (P1-P4).
- **Web UI** — 5-page management interface for sources, services, health monitoring, and configuration. Dark theme, real-time updates.
- **Chaos Engineering** — Built-in demo with 3 microservices and chaos injection (CPU spikes, error floods, memory leaks) — all correlated across signals.
- **Pluggable Connectors** — Add new backends by implementing one interface. Each connector owns its native query language (PromQL, LogQL, Flux, KQL...).
- **Authentication & TLS** — Connect to secured backends with Basic Auth, Bearer Token, custom CA certificates, and mutual TLS (mTLS). Configurable per source via Web UI or YAML.
- **Multi-Backend Support** — Connect multiple instances of the same backend type. Two Prometheus clusters? Three Loki instances? Just add more sources.

## Architecture

```mermaid
graph TB
    Agent["AI Agent<br/><small>Claude, Ollama, etc.</small>"]

    subgraph MCP ["observability-mcp :3000"]
        Tools["6 MCP Tools"]
        Analysis["Analysis Engine<br/><small>Z-score, Health Scoring, Correlation</small>"]
        UI["Web UI<br/><small>Dashboard, Sources, Services, Health, Settings</small>"]
    end

    subgraph Connectors ["Pluggable Connectors"]
        Prom["Prometheus<br/><small>PromQL</small>"]
        Loki["Loki<br/><small>LogQL</small>"]
        Next["Your Backend<br/><small>Any query language</small>"]
    end

    subgraph Services ["Example Microservices"]
        GW["API Gateway :8080"]
        Pay["Payment Service :8081<br/><small>chaos injection</small>"]
        Ord["Order Service :8082"]
    end

    Agent <-->|"MCP<br/>Streamable HTTP"| Tools
    Tools --- Analysis
    Tools --- UI
    MCP --> Prom & Loki & Next
    Prom & Loki -.->|scrape / collect| Services

    style MCP fill:#1a1a2e,stroke:#58a6ff,color:#fff
    style Connectors fill:#0d1117,stroke:#3fb950,color:#fff
    style Services fill:#0d1117,stroke:#f0883e,color:#fff
    style Agent fill:#58a6ff,stroke:#58a6ff,color:#000
    style Next fill:#0d1117,stroke:#3fb950,color:#8b949e,stroke-dasharray: 5 5
```

## How It Works

```
1. Services emit          2. Backends collect        3. MCP normalizes         4. Agent analyzes
┌─────────────────┐      ┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│ Your services    │ ──── │ Prometheus       │ ──── │ observability-   │ ──── │ LLM detects      │
│ emit metrics     │      │ scrapes metrics   │      │ mcp unifies     │      │ anomalies,       │
│ and logs         │      │ Loki collects    │      │ 6 tools + UI    │      │ correlates, and  │
│                  │      │ logs via Promtail │      │                  │      │ explains          │
└─────────────────┘      └──────────────────┘      └──────────────────┘      └──────────────────┘
```

## Installation

The server is published in two flavors. Pick what fits your stack:

| Method | Command | Best for |
|--------|---------|----------|
| **npm (npx)** | `npx @thotischner/observability-mcp` | Local dev, Node toolchains, zero install |
| **Docker (GHCR)** | `docker run -p 3000:3000 ghcr.io/thotischner/observability-mcp:latest` | Production, Kubernetes, isolation |
| **From source** | `git clone … && docker-compose up` | Full POC with example services and chaos |

### npm package

Published as [`@thotischner/observability-mcp`](https://www.npmjs.com/package/@thotischner/observability-mcp).

```bash
# Run latest
npx @thotischner/observability-mcp

# Pin a version
npx @thotischner/observability-mcp@1.0.0

# Or install globally
npm install -g @thotischner/observability-mcp
observability-mcp
```

### Docker image

Published as [`ghcr.io/thotischner/observability-mcp`](https://github.com/ThoTischner/observability-mcp/pkgs/container/observability-mcp). Multi-arch (amd64 + arm64).

```bash
# Pull and run, persisting config to a host volume
docker run -d \
  --name observability-mcp \
  -p 3000:3000 \
  -v $HOME/.observability-mcp:/home/node/.observability-mcp \
  ghcr.io/thotischner/observability-mcp:latest

# Pin a version
docker run -p 3000:3000 ghcr.io/thotischner/observability-mcp:v1.0.0

# With backend URLs preconfigured via env
docker run -p 3000:3000 \
  -e PROMETHEUS_URL=http://prometheus:9090 \
  -e LOKI_URL=http://loki:3100 \
  ghcr.io/thotischner/observability-mcp:latest
```

Available tags: `latest`, `main`, `vX.Y.Z`, `X.Y`, `X`, `sha-<commit>`.

### docker-compose snippet

```yaml
services:
  observability-mcp:
    image: ghcr.io/thotischner/observability-mcp:latest
    ports:
      - "3000:3000"
    environment:
      PROMETHEUS_URL: http://prometheus:9090
      LOKI_URL: http://loki:3100
    volumes:
      - ./mcp-config:/home/node/.observability-mcp
    restart: unless-stopped
```

## Quick Start

### Option A: Standalone (connect to your own backends)

```bash
npx @thotischner/observability-mcp
```

The server starts on **http://localhost:3000**. No backends are configured yet — add them through the Web UI:

1. Open **http://localhost:3000** → go to **Sources**
2. Click **+ Add Source** → select type (Prometheus, Loki), enter your backend URL
3. The source connects immediately — go to **Services** to see auto-discovered services
4. Point your AI client (Claude, etc.) to the MCP endpoint: `http://localhost:3000/mcp`

Configuration is saved to `~/.observability-mcp/sources.yaml` and persists across restarts. For secured backends, see [Authentication & TLS](#authentication--tls).

You can also skip the Web UI and configure via environment variables:

```bash
PROMETHEUS_URL=http://localhost:9090 LOKI_URL=http://localhost:3100 npx @thotischner/observability-mcp
```

### Option B: Grafana Cloud (managed Prometheus + Loki)

Grafana Cloud uses **Basic Auth** with your numeric **instance ID** as username and an API token as password. Find both under *Connections → Data sources → Prometheus / Loki* in your Grafana Cloud stack.

Create `~/.observability-mcp/sources.yaml`:

```yaml
sources:
  - name: grafana-cloud-prom
    type: prometheus
    url: https://prometheus-prod-XX-prod-eu-west-X.grafana.net/api/prom
    enabled: true
    auth:
      type: basic
      username: "${GRAFANA_PROM_USER}"   # numeric instance ID
      password: "${GRAFANA_TOKEN}"
  - name: grafana-cloud-loki
    type: loki
    url: https://logs-prod-XXX.grafana.net
    enabled: true
    auth:
      type: basic
      username: "${GRAFANA_LOKI_USER}"   # numeric instance ID (different from prom!)
      password: "${GRAFANA_TOKEN}"
```

Then start with env vars set:

```bash
GRAFANA_PROM_USER=123456 \
GRAFANA_LOKI_USER=789012 \
GRAFANA_TOKEN=glc_eyJ... \
npx @thotischner/observability-mcp
```

### Option C: Full Demo (Docker Compose with example services)

```bash
git clone https://github.com/ThoTischner/observability-mcp.git
cd observability-mcp
docker-compose up --build
```

This starts all 8 containers with health checks and dependency ordering:

1. Example services start and generate traffic automatically
2. Prometheus scrapes metrics, Loki collects logs via Promtail
3. MCP server connects to both backends
4. Agent starts the detection loop (with optional Ollama integration)

Open **http://localhost:3000** for the Web UI.

## MCP Tools

| Tool | Signal | Purpose |
|------|--------|---------|
| `list_sources` | meta | Discover configured backends and their connection status |
| `list_services` | meta | Discover monitored services across all backends |
| `query_metrics` | metrics | Query metrics with pre-computed summary stats (dynamic metric list) |
| `query_logs` | logs | Query logs with error/warning counts and top patterns |
| `get_service_health` | unified | Health score combining metrics + logs (0-100, configurable) |
| `detect_anomalies` | unified | Cross-signal anomaly detection with z-score analysis |

## Web UI

The management UI at **http://localhost:3000** has 5 pages:

- **Dashboard** — overview of sources, services, MCP endpoint
- **Sources** — add/edit/delete/test backends with authentication (Basic/Bearer), TLS settings (custom CA, mTLS, skip verify), and enable/disable toggle
- **Services** — auto-discovered services across all backends
- **Health** — real-time health cards with scores, metrics, anomalies (auto-refresh)
- **Settings** — General (check interval, sensitivity), Health Scoring (thresholds, weights), Source Metrics (per-source query definitions)

## Demo: Chaos Engineering

Three example microservices generate traffic automatically and support chaos injection:

```bash
# Trigger CPU spike on payment service
curl -X POST http://localhost:8081/chaos/high-cpu

# Trigger error spike (correlated: also increases CPU + latency + error logs)
curl -X POST http://localhost:8081/chaos/error-spike

# Trigger slow responses (correlated: increases CPU)
curl -X POST http://localhost:8081/chaos/slow-responses

# Trigger memory leak (correlated: generates OOM error logs)
curl -X POST http://localhost:8081/chaos/memory-leak

# Reset all chaos
curl -X POST http://localhost:8081/chaos/reset
```

The agent detects anomalies within 30 seconds and produces an incident analysis (if Ollama is running).

## Verify your setup

Three quick checks after starting the server:

```bash
# 1. Server is up and reports source health
curl http://localhost:3000/api/health

# 2. Tools list is reachable through the MCP endpoint
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

3. Open the Web UI at **http://localhost:3000 → Sources**. Each configured source should show a green status indicator. If red, click *Test* to see the error.

## Using with Claude Code

Connect Claude Code directly to your observability stack — no agent needed.

**Option 1 — CLI:**

```bash
claude mcp add observability --transport http http://localhost:3000/mcp
```

**Option 2 — `.mcp.json` in your project root** (commit-friendly):

```json
{
  "mcpServers": {
    "observability": {
      "transport": { "type": "http", "url": "http://localhost:3000/mcp" }
    }
  }
}
```

Verify with `claude mcp list`. Then ask Claude to investigate your infrastructure using natural language — Claude will call the MCP tools automatically.

### Example: Health Check

**Prompt:** *"Check the health of all services"*

Claude calls `get_service_health` for each service and returns:

```json
{
  "service": "payment-service",
  "status": "healthy",
  "score": 100,
  "signals": {
    "metrics": { "cpu": 17.2, "memory": 125.0, "errorRate": 0, "latencyP99": 0.0099 },
    "logs": { "errorRate": 0, "topErrors": [] }
  },
  "anomalies": [],
  "correlations": []
}
```

### Example: Incident Investigation

After triggering chaos (`curl -X POST http://localhost:8081/chaos/error-spike`), ask Claude: *"Are there any anomalies?"*

Claude calls `detect_anomalies` and finds:

```json
{
  "scannedServices": 3,
  "anomalies": [
    {
      "metric": "cpu",
      "severity": "high",
      "description": "cpu is 3.4σ above baseline (18.36 → 37.31)",
      "currentValue": 37.31,
      "baselineValue": 18.36,
      "deviationPercent": 103,
      "service": "payment-service"
    },
    {
      "metric": "request_rate",
      "severity": "low",
      "description": "request_rate is -1.8σ below baseline (0.08 → 0.04)",
      "currentValue": 0.04,
      "baselineValue": 0.08,
      "deviationPercent": -55,
      "service": "payment-service"
    }
  ],
  "summary": "2 anomalies detected across 1 service(s)."
}
```

Then ask *"Show me the error logs for payment-service"* — Claude calls `query_logs`:

```json
{
  "service": "payment-service",
  "summary": {
    "total": 11,
    "errorCount": 11,
    "warnCount": 0,
    "topPatterns": [
      "Request failed: internal error during POST /payments (6x)",
      "Request failed: internal error during POST /refunds (4x)",
      "Request failed: internal error during GET / (1x)"
    ]
  }
}
```

Claude correlates the signals: CPU spike (+114%), error logs flooding, request rate halved — and explains the incident in plain language. All without writing a single PromQL or LogQL query.

## Ollama Integration (Agent only)

The **agent** (not the MCP server) uses Ollama for LLM-powered incident analysis. The MCP server itself is LLM-agnostic — it just provides tools and data.

```bash
ollama serve
ollama pull llama3.1:8b
```

The agent is configured entirely via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_URL` | `http://host.docker.internal:11434` | Ollama API endpoint |
| `OLLAMA_MODEL` | `llama3.1:8b` | Model for incident analysis |
| `SYSTEM_PROMPT` | *(built-in SRE prompt)* | Custom instructions for the LLM |
| `CHECK_INTERVAL` | `30000` | Detection loop interval (ms) |

If Ollama is unavailable, the agent falls back to raw anomaly JSON output.

## Adding a New Connector

Each connector type brings its own default metrics in its native query language.

1. Create `mcp-server/src/connectors/<name>.ts`
2. Implement the `ObservabilityConnector` interface (see `interface.ts`)
3. Implement `getDefaultMetrics()` returning `MetricDefinition[]` with backend-specific queries
4. Register the factory in `mcp-server/src/connectors/registry.ts`
5. Add a source via the Web UI or `config/sources.yaml`

Example: an InfluxDB connector would return Flux queries in `getDefaultMetrics()`, an Elasticsearch connector would return KQL queries.

## Authentication & TLS

Every source supports optional authentication and TLS configuration — via the Web UI or in `sources.yaml`.

### Basic Auth

```yaml
sources:
  - name: prometheus-prod
    type: prometheus
    url: https://prometheus.internal:9090
    enabled: true
    auth:
      type: basic
      username: admin
      password: secret
```

### Bearer Token

Common for Grafana Cloud, managed Prometheus/Loki, or OAuth2 proxy setups.

```yaml
sources:
  - name: grafana-cloud-metrics
    type: prometheus
    url: https://prometheus-us-central1.grafana.net/api/prom
    enabled: true
    auth:
      type: bearer
      token: glc_eyJ...
```

### Custom CA Certificate (self-signed certs)

Instead of disabling TLS verification, provide your CA certificate for secure validation:

```yaml
sources:
  - name: prometheus-internal
    type: prometheus
    url: https://prometheus.corp:9090
    enabled: true
    tls:
      caCert: /etc/ssl/custom-ca.pem
```

### Mutual TLS (mTLS)

For environments that require client certificate authentication:

```yaml
sources:
  - name: prometheus-mtls
    type: prometheus
    url: https://prometheus.secure:9090
    enabled: true
    tls:
      caCert: /etc/ssl/ca.pem
      clientCert: /etc/ssl/client.pem
      clientKey: /etc/ssl/client-key.pem
```

### Skip TLS Verification

For development or testing with self-signed certificates where you don't have the CA:

```yaml
sources:
  - name: prometheus-dev
    type: prometheus
    url: https://prometheus.dev:9090
    enabled: true
    tls:
      skipVerify: true
```

All of these options are also available in the Web UI under **Sources > Add/Edit Source**.

## Configuration

### Where does my config live?

| Mode | Host path | Path inside container |
|------|-----------|-----------------------|
| `npx` / global install | `~/.observability-mcp/sources.yaml` | — |
| Docker (GHCR image) | any host path you mount | `/home/node/.observability-mcp/sources.yaml` |
| docker-compose (this repo) | `mcp-server/config/sources.yaml` | `/app/config/sources.yaml` |
| Custom | `$CONFIG_PATH` | `$CONFIG_PATH` |

The Web UI writes to whichever path resolves first (precedence: `CONFIG_PATH` → `./config/sources.yaml` → `~/.observability-mcp/sources.yaml`).

### Env var substitution in `sources.yaml`

`${VAR}` and `${VAR:-default}` placeholders are expanded at load time using `process.env`. This lets you commit `sources.yaml` to source control while keeping secrets in a `.env` file:

```yaml
sources:
  - name: grafana-cloud-prom
    type: prometheus
    url: "${GRAFANA_PROM_URL}"
    enabled: true
    auth:
      type: basic
      username: "${GRAFANA_PROM_USER}"
      password: "${GRAFANA_TOKEN}"
```

Undefined vars without a default produce a warning and an empty string (no crash).

```yaml
sources:
  - name: prometheus
    type: prometheus
    url: http://localhost:9090           # or http://prometheus:9090 in Docker
    enabled: true
    # auth:                              # Optional: authentication
    #   type: bearer
    #   token: eyJ...
    # tls:                               # Optional: TLS settings
    #   caCert: /path/to/ca.pem
    #   clientCert: /path/to/client.pem  # Optional: mTLS
    #   clientKey: /path/to/client-key.pem
    # metrics: [...]                     # Optional: override default metrics

  - name: loki
    type: loki
    url: http://localhost:3100           # or http://loki:3100 in Docker
    enabled: true

settings:
  checkIntervalMs: 30000
  defaultSensitivity: medium             # low, medium, high

healthThresholds:
  weights: { errorRate: 0.35, latency: 0.25, cpu: 0.20, logErrors: 0.20 }
  cpu: { good: 50, warn: 80, crit: 95 }
  errorRate: { good: 0.01, warn: 0.1, crit: 0.5 }
  latencyP99: { good: 0.5, warn: 1.0, crit: 3.0 }
  logErrors: { good: 1, warn: 5, crit: 20 }
  statusBoundaries: { healthy: 80, degraded: 50 }
```

### Environment Variables

For quick setup without a config file — the server picks these up when no `sources.yaml` exists:

| Variable | Description | Example |
|----------|-------------|---------|
| `PORT` | HTTP port for MCP endpoint and Web UI (default: `3000`) | `8080` |
| `PROMETHEUS_URL` | Prometheus URL(s), comma-separated for multiple | `http://prom1:9090,http://prom2:9090` |
| `LOKI_URL` | Loki URL(s), comma-separated for multiple | `http://loki1:3100,http://loki2:3100` |
| `LOKI_SERVICE_LABELS` | Comma-separated label names probed when discovering services and resolving log queries (default: `service_name,service,job,app,container`) | `service_name,container,job` |
| `CONFIG_PATH` | Custom path to `sources.yaml` | `/etc/observability-mcp/sources.yaml` |

```bash
# Single backend
PROMETHEUS_URL=http://localhost:9090 npx @thotischner/observability-mcp

# Multiple backends on custom port
PROMETHEUS_URL=http://prom1:9090,http://prom2:9090 \
LOKI_URL=http://loki1:3100,http://loki2:3100 \
PORT=8080 \
npx @thotischner/observability-mcp
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Claude doesn't see the tools | Server not registered or not reachable | `claude mcp list` — re-add if missing; verify `curl http://localhost:3000/mcp` works |
| `EADDRINUSE: 3000` on start | Another process owns the port | `lsof -i :3000` (or `ss -tlnp \| grep 3000`); pick another port via `PORT=8080` |
| Source connects, queries return empty | Wrong auth scheme or URL path | Check server logs (`docker logs observability-mcp`); for Grafana Cloud use Basic Auth with numeric instance ID, not Bearer |
| Server starts with no sources | No `sources.yaml` and no `PROMETHEUS_URL`/`LOKI_URL` set | Expected — add via Web UI or env vars; this is by design |
| `${VAR}` shows up literally in UI | Env var not set when server started | Set the var in shell/`.env` before launch; substitution happens at file load |
| Web UI shows red source indicator | Health check failing | Click *Test* in source row — error message tells you what's wrong (DNS, TLS, 401, etc.) |

## Endpoints

**Always available (standalone & Docker):**

| Service | URL |
|---------|-----|
| MCP Server (Streamable HTTP) | http://localhost:3000/mcp |
| Web UI | http://localhost:3000 |

**Docker Compose demo only:**

| Service | URL |
|---------|-----|
| Prometheus | http://localhost:9090 |
| Loki | http://localhost:3100 |
| API Gateway | http://localhost:8080 |
| Payment Service | http://localhost:8081 |
| Order Service | http://localhost:8082 |

## Tech Stack

- TypeScript, Node 20 (all components)
- `@modelcontextprotocol/sdk` (MCP server + client, Streamable HTTP transport)
- Express, Zod, js-yaml
- `prom-client` (example service metrics)
- Prometheus, Loki, Promtail (observability stack)
- Ollama (local LLM for incident analysis)
- Docker Compose with health checks

## Requirements

**Standalone:** Node.js 20+ (or just use `npx`)

**Docker Demo:** Docker and Docker Compose, 4GB+ RAM (8GB+ with Ollama)

**Optional:** Ollama on host machine for AI-powered incident analysis

## Security

Continuous security automation runs on this repo:

- **Dependabot** — weekly grouped PRs for npm, GitHub Actions, and Docker base images
- **CodeQL** — static analysis (security-extended + quality queries) on every PR and weekly
- **Trivy** — Docker image and filesystem scans for CRITICAL/HIGH CVEs, results in the Security tab
- **npm audit** — fails CI on `--audit-level=high` issues
- **OSSF Scorecard** — repo posture analysis, results uploaded weekly
- **Auto-merge** — Dependabot patch/minor PRs auto-merge after a 72h cooldown if all checks pass; majors stay manual
- **Auto-release** — weekly cron tags a patch release if there are merged commits since the last tag, which triggers npm + GHCR + GitHub Release automatically

To report a vulnerability, please open a private security advisory on GitHub.

## Contributing

Contributions are welcome! The easiest way to get started:

1. Fork the repo and `docker-compose up --build`
2. Pick an issue or open one to discuss your idea
3. Submit a PR — all code runs in Docker, no local dependencies needed

Ideas: new connectors (InfluxDB, Elasticsearch, Datadog), additional analysis algorithms, UI improvements.

## License

MIT

---

<div align="center">

If you find this useful, consider giving it a star — it helps others discover the project.

</div>
