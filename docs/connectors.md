# Connectors

Each backend is a connector that owns its native query language. The MCP tool layer stays backend-agnostic.

Currently shipped: **Prometheus** (PromQL, metrics), **Loki** (LogQL, logs), and **Kubernetes** (watch-based, topology). Adding a new one means implementing one interface — see the [Kubernetes connector reference](kubernetes.md) for an example of a connector that emits a `Resource`/`Edge` graph instead of metrics or logs.

Optional connectors (Datadog, Grafana, Elasticsearch, …) are distributed via the [Connector Hub](https://thotischner.github.io/observability-mcp/hub/) and can be added to a running server without a rebuild — via the Web UI's **Connectors** page (browse the hub, install, or upload a signed `.tgz`), the `omcp plugin install` CLI, or the Helm bundle image. The runtime install paths are fail-closed and off by default; see [`docs/plugin-architecture.md`](plugin-architecture.md#the-connector-hub) for the API, guardrails (`ENABLE_UI_INSTALL` + trust root), and Kubernetes persistence.

## Adding a new connector

1. Create `mcp-server/src/connectors/<name>.ts`.
2. Implement `ObservabilityConnector` (see `mcp-server/src/connectors/interface.ts`):
   - `connect(config)` — initialize URL, auth, TLS
   - `healthCheck()` — return `up`/`down` plus latency and a message
   - `disconnect()` — best-effort cleanup
   - `listServices()` — discover services from the backend
   - `getDefaultMetrics()` / `getMetrics()` — return `MetricDefinition[]` in the backend's query language
   - `queryMetrics?()` and/or `queryLogs?()` — implement what the backend supports
   - `listResources?()` / `listEdges?()` / `getTopologySnapshot?()` / `watchTopology?()` — implement these if your backend models infrastructure topology (Kubernetes pods on nodes, VMs on hypervisors, …). The `isTopologyProvider()` guard in `interface.ts` is the contract the new MCP tools (`get_topology`, `get_blast_radius`) and the Web UI Topology page consume. Emit `kind` and `relation` values from the canonical [topology vocabulary](topology-vocabulary.md) so cross-connector reasoning works; the validator in `topology-vocabulary.ts` warns on drift.
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
