# Airgapped deployment

observability-mcp is designed to run in environments with **no outbound internet access**. This document covers the moving parts — image distribution, plugin loading, configuration — and what to mirror into an internal registry.

## What needs to reach the cluster

| Artifact | Where to mirror | Notes |
|---|---|---|
| Container image | Internal OCI registry (e.g. Harbor, Artifactory, ECR) | `ghcr.io/thotischner/observability-mcp:<tag>` — multi-arch (amd64+arm64) |
| Helm chart | OCI registry or chartmuseum | Published from `helm/observability-mcp/` |
| (Optional) Plugin tarballs | Internal HTTP server or baked into the image | See "Connectors as plugins" below |

That's it. The server itself makes no outbound calls at startup — sources are configured at runtime via the Web UI or `sources.yaml`.

## Image mirroring

```bash
# On a machine with both internet and registry access:
docker pull ghcr.io/thotischner/observability-mcp:1.3.4
docker tag  ghcr.io/thotischner/observability-mcp:1.3.4 registry.internal.example/observability-mcp:1.3.4
docker push registry.internal.example/observability-mcp:1.3.4
```

If you verify SBOM/provenance attestations (recommended for regulated environments), pull them too:

```bash
cosign download attestation \
  --predicate-type https://spdx.dev/Document \
  ghcr.io/thotischner/observability-mcp:1.3.4 > sbom.json
```

The image is signed via Sigstore keyless OIDC against the GitHub Actions workflow that built it. Verify before mirroring.

## Helm install in the airgapped cluster

Point `image.repository` at the internal mirror and disable anything that would call out:

```yaml
# values.yaml
image:
  repository: registry.internal.example/observability-mcp
  tag: "1.3.4"
  pullPolicy: IfNotPresent

# No ingress to the public internet; expose via internal LB or service mesh.
ingress:
  enabled: true
  className: nginx-internal
  hosts:
    - host: observability-mcp.platform.internal
      paths: [{ path: /, pathType: Prefix }]

# Mount sources inline so no UI-driven changes are needed.
sources:
  config: |
    sources:
      - name: prometheus
        type: prometheus
        url: http://prometheus.monitoring.svc.cluster.local:9090
        enabled: true
      - name: loki
        type: loki
        url: http://loki.logging.svc.cluster.local:3100
        enabled: true

auth:
  enabled: true
  existingSecret: observability-mcp-auth   # provisioned out-of-band

# Lock down egress to only the cluster's observability namespaces.
networkPolicy:
  enabled: true
  egress:
    - to:
        - namespaceSelector:
            matchLabels: { name: monitoring }
        - namespaceSelector:
            matchLabels: { name: logging }
      ports:
        - { port: 9090, protocol: TCP }
        - { port: 3100, protocol: TCP }
```

Install:

```bash
helm install observability-mcp ./observability-mcp-0.3.0.tgz -f values.yaml -n platform
```

## Connectors as plugins

The Prometheus and Loki connectors ship **inside the image** as filesystem plugins (`/app/plugins/prometheus/`, `/app/plugins/loki/`). Nothing is fetched at runtime; no `npm install` happens after build. This is the path for airgapped environments.

### Adding a private connector

For a connector you maintain internally (say, a connector to your internal metrics service), build a tarball with the manifest format documented in [`docs/plugin-architecture.md`](plugin-architecture.md) and bake it into a derived image:

```dockerfile
FROM registry.internal.example/observability-mcp:1.3.4

# Plugin directory layout (see docs/plugin-architecture.md):
#   plugins/<name>/manifest.json   — Zod-validated metadata
#   plugins/<name>/package.json    — entry point
#   plugins/<name>/index.js        — exports the connector factory

COPY ./internal-connector /app/plugins/internal-connector
```

The PluginLoader scans `/app/plugins/` at startup and validates each manifest. Failed validation rejects the plugin (with a logged reason) but doesn't block server startup — the operator can `PLUGINS_DISABLED=internal-connector` to opt out at runtime without rebuilding.

### Verifying plugin provenance

If your security policy requires signed plugins, run the verification step in a pre-build hook before `COPY`:

```bash
cosign verify-blob \
  --signature internal-connector.sig \
  --certificate internal-connector.cert \
  internal-connector.tar.gz
```

A future release will fold this into the PluginLoader as an opt-in `PLUGIN_REQUIRE_SIGNATURE=true` mode.

## Configuration without the Web UI

Two ways to declare sources without anyone clicking through the UI:

1. **Mount a ConfigMap** at `/app/config/sources.yaml`. The Helm chart handles this via `sources.config` (see above).
2. **Environment variables** — `PROMETHEUS_URL`, `LOKI_URL`, comma-separated for multiple backends. Useful for ephemeral CI environments.

GitOps-friendly: commit `values.yaml` + a sealed `auth.token` secret. No state in the cluster except the optional `persistence` volume (which you typically disable in airgapped/GitOps mode).

## Telemetry off by default

observability-mcp ships **no built-in telemetry** — no startup phone-home, no usage pings, no error reporting back to the maintainer. Logs go to stdout, metrics go to your Prometheus, and that's it. Safe to run inside a fully isolated network without redaction.

## Updates

Releases are tagged in the GitHub repo. The recommended workflow:

1. Watch the public repo for new tags (or subscribe to GitHub releases).
2. Mirror the new image + chart on your internet-facing build host.
3. Promote into the airgapped registry through your usual change-management process.
4. `helm upgrade` with the new `image.tag` and `Chart.yaml` version.

The chart's `appVersion` always matches the recommended image tag. `helm template` shows what would change before you apply.

## Troubleshooting

- **`ImagePullBackOff`** — check that `image.repository` points at your mirror and that the mirror has the exact tag.
- **`/readyz` 503 forever** — the Express listener never came up. Inspect the pod logs; usually a malformed `sources.config`.
- **Plugins not loading** — the PluginLoader logs "plugin <name> rejected: <reason>" at startup. Filter `kubectl logs` for `plugin`.
- **Outbound DNS still resolving externally** — NetworkPolicy egress rules need a `to: namespaceSelector` matching your kube-dns namespace (often `kube-system`). The default chart values include this.
