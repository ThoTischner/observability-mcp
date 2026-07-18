# Install via Helm

The chart lives at the same Pages URL as these docs — so the same
host that serves the documentation also serves the Helm repo
index.

## Add the repo

```bash
helm repo add observability-mcp https://thotischner.github.io/observability-mcp
helm repo update
```

Look up the latest version:

```bash
helm search repo observability-mcp -l | head -5
```

## Install

```bash
helm install obs observability-mcp/observability-mcp \
  --namespace observability --create-namespace
```

The default values bring up a single-replica gateway in
anonymous-auth mode — fine for a private cluster + quick eval. For
anything shared see the hardening notes below.

## Common values

```bash
helm install obs observability-mcp/observability-mcp \
  --namespace observability --create-namespace \
  --set sources.prometheusUrl=http://kube-prometheus-stack-prometheus:9090 \
  --set sources.lokiUrl=http://loki:3100 \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=observability-mcp.example.com \
  --set auth.enabled=true \
  --set auth.token=$(openssl rand -hex 24)
```

Everything the chart accepts: see
[`helm/observability-mcp/values.yaml`](https://github.com/ThoTischner/observability-mcp/blob/main/helm/observability-mcp/values.yaml)
in the repo (also `helm show values observability-mcp/observability-mcp`).
The chart ships with `values.schema.json` so Helm validates input
types before render.

## Verify the chart signature (optional)

The chart packages are GPG-signed. The signing key fingerprint is
documented in
[`Chart.yaml` annotations](https://github.com/ThoTischner/observability-mcp/blob/main/helm/observability-mcp/Chart.yaml).
Verify before install:

```bash
curl -sSL https://raw.githubusercontent.com/ThoTischner/observability-mcp/main/docs/helm-signing.pub.asc \
  | gpg --import

helm fetch observability-mcp/observability-mcp --prov
helm verify observability-mcp-*.tgz
```

The OCI variant (see below) is additionally **cosign-signed**.

## Install from OCI (alternative)

The same chart is published to GHCR as an OCI artifact, signed by
cosign with keyless OIDC:

```bash
helm install obs oci://ghcr.io/thotischner/charts/observability-mcp \
  --version 2.0.0 \
  --namespace observability --create-namespace

# Verify the cosign signature
cosign verify ghcr.io/thotischner/charts/observability-mcp:2.0.0 \
  --certificate-identity-regexp 'https://github.com/ThoTischner/observability-mcp' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Capabilities you turn on with values

| Value | What it enables | Docs |
|---|---|---|
| `auth.enabled: true` | API-key auth | [auth-basic.md](auth-basic.md) |
| `oidc.enabled: true` | OIDC SSO + sessions | [auth-oidc.md](auth-oidc.md) |
| `airgapped: true` | Egress-deny NetworkPolicy + `OMCP_AIRGAPPED` | [airgapped-deployment.md](airgapped-deployment.md) |
| `anomalyHistory.enabled: true` | TSDB-backed anomaly history sink | [anomaly-history.md](anomaly-history.md) |
| `redis.enabled: true` | Shared session store for multi-replica HA | [horizontal-scaling.md](horizontal-scaling.md) |
| `serviceMonitor.enabled: true` | Prometheus Operator scrape config | [self-observability.md](self-observability.md) |
| `plugins.image: ghcr.io/thotischner/observability-mcp-plugins:latest` (default) | Bundled signed connectors | [plugin-architecture.md](plugin-architecture.md) |
| `plugins.uiInstall: true` | Web UI / API plugin install endpoints | [plugin-architecture.md](plugin-architecture.md) |

## Upgrade

```bash
helm repo update
helm upgrade obs observability-mcp/observability-mcp \
  --namespace observability --reuse-values
```

For breaking changes between major versions consult the matching
migration guide:

- [1.x → 2.0](migrations/1.x-to-2.0.md)
- [2.x → 3.0](migrations/2.x-to-3.0.md)

## Uninstall

```bash
helm uninstall obs --namespace observability
```

The PVC for plugin persistence (if enabled) is kept by default —
delete it explicitly with `kubectl delete pvc -n observability -l
app.kubernetes.io/name=observability-mcp` if you want a clean
slate.

## Troubleshooting

- **`/readyz` 503 forever** — Express listener never came up;
  usually a malformed `sources.config`. `kubectl logs` the pod and
  look for the first error in startup.
- **`ImagePullBackOff`** — your cluster needs to reach `ghcr.io`,
  or set `image.repository` to your internal mirror.
- **Plugins not loading** — the PluginLoader logs
  `plugin <name> rejected: <reason>` at startup. Filter
  `kubectl logs` for `plugin`.
- **`helm repo add` 404 on index.yaml** — the published Pages site
  carries both the MkDocs docs AND the Helm repo index at the
  same URL. If your client gets a 404, something's wrong with the
  docs-publish step — open an issue.
- **`helm search repo` doesn't show the newest chart** — run
  `helm repo update` first; Helm caches the index locally. In the first
  few minutes after a release the published index can also still be
  propagating, and no amount of `helm repo update` will help until it
  has — [install from OCI](#install-from-oci-alternative) in the
  meantime, which is served straight from the registry.
