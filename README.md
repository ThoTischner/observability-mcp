# observability-mcp Helm chart repository

Helm chart index for [observability-mcp](https://github.com/ThoTischner/observability-mcp).

```bash
helm repo add observability-mcp https://thotischner.github.io/observability-mcp/
helm repo update
helm install observability-mcp observability-mcp/observability-mcp
```

Chart sources live on the `main` branch under `helm/observability-mcp/`. This branch is auto-populated by `.github/workflows/helm-release.yml` on every `v*` tag.
