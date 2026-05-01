# Connectors

Each backend is a connector that owns its native query language. The MCP tool layer stays backend-agnostic.

Currently shipped: **Prometheus** (PromQL) and **Loki** (LogQL). Adding a new one means implementing one interface.

## Adding a new connector

1. Create `mcp-server/src/connectors/<name>.ts`.
2. Implement `ObservabilityConnector` (see `mcp-server/src/connectors/interface.ts`):
   - `connect(config)` — initialize URL, auth, TLS
   - `healthCheck()` — return `up`/`down` plus latency and a message
   - `disconnect()` — best-effort cleanup
   - `listServices()` — discover services from the backend
   - `getDefaultMetrics()` / `getMetrics()` — return `MetricDefinition[]` in the backend's query language
   - `queryMetrics?()` and/or `queryLogs?()` — implement what the backend supports
3. Register a factory in `mcp-server/src/connectors/registry.ts`:
   ```ts
   connectorFactories[type] = () => new MyConnector();
   ```
4. Add a source via the Web UI or `sources.yaml`.

## Examples of what defaults look like

An InfluxDB connector would emit Flux queries from `getDefaultMetrics()`:

```ts
{ name: "cpu", query: 'from(bucket: "telegraf") |> range(start: -1m) |> filter(fn: (r) => r["_measurement"] == "cpu" and r["service"] == "{{service}}")', unit: "percent" }
```

An Elasticsearch connector would emit KQL or DSL JSON, etc. The MCP tools (`query_metrics`, `query_logs`) call the connector and don't care about the language underneath.

## Multi-instance support

Connect multiple instances of the same type by adding more sources of that type. Each gets its own connection, health check, and service list.

```yaml
sources:
  - { name: prom-prod, type: prometheus, url: http://prom-prod:9090, enabled: true }
  - { name: prom-dev,  type: prometheus, url: http://prom-dev:9090,  enabled: true }
```
