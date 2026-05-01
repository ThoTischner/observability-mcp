# Configuration

All configuration is managed through `sources.yaml` and the Web UI, which is the same file viewed two ways. Changes via the UI persist immediately, no restart needed.

## Where does my config live?

| Mode | Host path | Path inside container |
|------|-----------|-----------------------|
| `npx` / global install | `~/.observability-mcp/sources.yaml` | — |
| Docker (GHCR image) | any host path you mount | `/home/node/.observability-mcp/sources.yaml` |
| docker-compose (this repo) | `mcp-server/config/sources.yaml` | `/app/config/sources.yaml` |
| Custom | `$CONFIG_PATH` | `$CONFIG_PATH` |

The Web UI writes to whichever path resolves first: `CONFIG_PATH` → `./config/sources.yaml` → `~/.observability-mcp/sources.yaml`.

## Environment variables

For quick setup without a config file — picked up when `sources.yaml` does not exist or the corresponding source is absent:

| Variable | Description | Example |
|----------|-------------|---------|
| `PORT` | HTTP port for MCP endpoint and Web UI (default `3000`) | `8080` |
| `PROMETHEUS_URL` | Prometheus URL(s), comma-separated for multiple | `http://prom1:9090,http://prom2:9090` |
| `LOKI_URL` | Loki URL(s), comma-separated for multiple | `http://loki1:3100,http://loki2:3100` |
| `PROMETHEUS_SERVICE_LABELS` | Labels probed for the service filter in metric queries (default `job,service,app,service_name`) | `service,job` |
| `LOKI_SERVICE_LABELS` | Labels probed for service discovery and log queries (default `service_name,service,job,app,container`) | `service_name,container,job` |
| `CONFIG_PATH` | Custom path to `sources.yaml` | `/etc/observability-mcp/sources.yaml` |

Example:

```bash
PROMETHEUS_URL=http://prom1:9090,http://prom2:9090 \
LOKI_URL=http://loki1:3100 \
PORT=8080 \
npx @thotischner/observability-mcp
```

## `${VAR}` substitution

Placeholders in `sources.yaml` are expanded from `process.env` at load time. Both `${VAR}` and `${VAR:-default}` are supported. Undefined vars without a default produce a warning and an empty string (no crash).

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

This lets you commit `sources.yaml` to source control while keeping secrets in a `.env` file.

## Full `sources.yaml` reference

```yaml
sources:
  - name: prometheus              # display name, must be unique
    type: prometheus              # connector type: prometheus | loki
    url: http://localhost:9090
    enabled: true
    auth:                         # optional, see auth-and-tls.md
      type: basic                 # none | basic | bearer
      username: admin
      password: secret
    tls:                          # optional, see auth-and-tls.md
      caCert: /path/to/ca.pem
      clientCert: /path/to/client.pem
      clientKey: /path/to/client-key.pem
      skipVerify: false
    metrics:                      # optional per-source overrides; merge with defaults by name
      - name: cpu
        query: 'rate(my_cpu_metric{ {{selector}} }[1m])'
        unit: percent
        description: Custom CPU query

settings:
  checkIntervalMs: 30000          # agent detection loop interval
  defaultSensitivity: medium      # low | medium | high

healthThresholds:
  weights: { errorRate: 0.35, latency: 0.25, cpu: 0.20, logErrors: 0.20 }
  cpu:        { good: 50,  warn: 80,  crit: 95 }
  errorRate:  { good: 0.01, warn: 0.1, crit: 0.5 }
  latencyP99: { good: 0.5, warn: 1.0, crit: 3.0 }
  logErrors:  { good: 1,   warn: 5,   crit: 20 }
  statusBoundaries: { healthy: 80, degraded: 50 }
```

Per-source `metrics` overrides merge with the connector's defaults by `name`. Pin one metric to a custom query without re-listing the rest.
