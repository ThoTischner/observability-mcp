# Security

## Reporting a vulnerability

Please open a private security advisory on GitHub: https://github.com/ThoTischner/observability-mcp/security/advisories/new

## Continuous security automation

The repo runs a self-driving security pipeline so issues get caught and patched without manual sweeping.

| Mechanism | What it does | Cadence |
|-----------|--------------|---------|
| **Dependabot** | Grouped PRs for npm (mcp-server, agent), GitHub Actions, and Docker base images | Weekly, Monday |
| **CodeQL** | Static analysis with `security-extended` + quality queries; results in the Security tab | PR + weekly |
| **Trivy** | Docker image and filesystem scans for CRITICAL/HIGH CVEs (SARIF upload) | PR + daily |
| **npm audit** | Fails CI on `--audit-level=high` | PR + daily |
| **OSSF Scorecard** | Repo posture analysis published to the Security tab | Weekly |
| **Auto-merge sweeper** | Merges Dependabot PRs ≥ 72 h old when checks pass; majors stay manual | Daily |
| **Auto-release** | Patch-bumps + tags if commits landed since the last release; triggers npm + GHCR + GitHub Release | Weekly, Sunday |

## Built-in protections

- **Input validation** for durations, metric names, and service identifiers (length-bounded, character-allowlisted).
- **PromQL/LogQL injection** guarded by per-language escape helpers around quoted label values.
- **SSRF** mitigated for source URLs: cloud metadata endpoints and non-HTTP schemes are rejected.
- **Security headers** (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy) on Web UI responses.
- **Body size limits** on JSON request bodies.
- **Session TTL** of 30 minutes with periodic cleanup.
- **Non-root user** in the Docker image (`USER node`).
- **npm provenance** on every published version (SLSA build attestation).

## Token / secret handling

- Do not bake secrets into `sources.yaml`. Use `${VAR}` substitution and supply them via env or a `.env` file.
- The container reads `sources.yaml` from a mounted volume — nothing about credentials lives in the image layer.
- GitHub repository secrets used by CI: `NPM_TOKEN` (npm publish), `RELEASE_PAT` (lets the auto-release tag push trigger downstream workflows). Both are injected only into the workflows that need them.
