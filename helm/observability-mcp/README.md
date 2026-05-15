# observability-mcp Helm chart

Deploys [observability-mcp](https://github.com/ThoTischner/observability-mcp) — a Model Context Protocol server that gives AI agents unified access to Prometheus, Loki, and other observability backends.

Browse available connectors in the **[Connector Hub](https://thotischner.github.io/observability-mcp/hub/)** — pair it with the chart's `plugins.image` / `plugins.verify` values for signed, airgapped connector delivery.

## Quick start

```bash
helm repo add observability-mcp https://thotischner.github.io/observability-mcp
helm install obs-mcp observability-mcp/observability-mcp \
  --set sources.prometheusUrl=http://prometheus.monitoring.svc:9090 \
  --set sources.lokiUrl=http://loki.logging.svc:3100
```

Or from source:

```bash
helm install obs-mcp ./helm/observability-mcp \
  --set sources.prometheusUrl=http://prometheus:9090
```

## Configuration

| Key | Default | Description |
|---|---|---|
| `image.repository` | `ghcr.io/thotischner/observability-mcp` | Container image |
| `image.tag` | _(chart appVersion)_ | Override with a specific release tag |
| `replicaCount` | `1` | Increase only with sticky-session ingress |
| `auth.enabled` | `false` | Require `MCP_AUTH_TOKEN` on `/mcp` |
| `auth.existingSecret` | `""` | Reference an existing Secret with key `token` |
| `sources.config` | `""` | Inline `sources.yaml` content (mounted as ConfigMap) |
| `sources.prometheusUrl` | `""` | Alternative: single Prometheus URL via env |
| `sources.lokiUrl` | `""` | Alternative: single Loki URL via env |
| `ingress.enabled` | `false` | Expose externally |
| `persistence.enabled` | `false` | Persist `sources.yaml` updates from the Web UI |
| `autoscaling.enabled` | `false` | HPA — only with sticky-session ingress |
| `podSecurityContext.runAsNonRoot` | `true` | Hardened defaults |
| `plugins.image` | `ghcr.io/thotischner/observability-mcp-plugins:latest` | Official signed connector bundle; an init container extracts it into `/app/plugins` (no registry access from the main pod). Connectors stay inert until a matching source is configured. `""` disables it (builtin Prometheus/Loki only) |
| `plugins.paths` | `[]` | Subdirs of `/plugins` to extract (empty = all) |
| `plugins.verify.enabled` | `false` | Fail-closed connector verification (`VERIFY_PLUGINS`) — builtin Prometheus/Loki are never gated |
| `plugins.verify.trustRootPem` | `""` | PEM public key trust root (rendered into a Secret) |
| `plugins.verify.existingSecret` | `""` | Instead reference a Secret with key `trust-root.pem` |

See [`values.yaml`](./values.yaml) for the full schema and
[`docs/plugin-architecture.md`](../../docs/plugin-architecture.md) for the
airgapped plugin + verification model.

## Multi-replica deployments

The MCP Streamable HTTP transport holds session state per pod. To run more than one replica you need either:

- **Sticky sessions at the ingress** — for nginx-ingress:
  ```yaml
  ingress:
    enabled: true
    annotations:
      nginx.ingress.kubernetes.io/affinity: cookie
      nginx.ingress.kubernetes.io/session-cookie-name: mcp-session
      nginx.ingress.kubernetes.io/session-cookie-max-age: "3600"
  replicaCount: 3
  ```
- **Or a single replica** — the default. Good enough for most SRE-tooling workloads.

A shared session store is on the roadmap.

## Security

- `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, capabilities dropped
- `automountServiceAccountToken: false` by default
- Set `auth.enabled=true` and provide a token — the `/mcp` endpoint is unauthenticated otherwise
- The chart does not provision a NetworkPolicy by default; tighten egress to your Prometheus/Loki hosts in your own policy

## Upgrading

```bash
helm upgrade obs-mcp observability-mcp/observability-mcp -f my-values.yaml
```

Major-version bumps of the chart will be documented in the CHANGELOG.

## License

MIT — same as the upstream project.
