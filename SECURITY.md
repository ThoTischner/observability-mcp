# Security policy

## Supported versions

Security fixes are issued for the latest minor release line on npm and GHCR.
Older minors do not receive patches; upgrading is the supported remediation
path.

| Version | Supported |
|---------|-----------|
| 1.x     | ✅ — latest minor receives fixes |
| < 1.0   | ❌ — pre-release, do not run in production |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security reports.**

Report privately via one of:

- **GitHub Security Advisories** — preferred. https://github.com/ThoTischner/observability-mcp/security/advisories/new
- **Email** — `ai-solutions-camp@email.de`

What to include:

1. A description of the issue and its impact.
2. Reproduction steps or a proof-of-concept. The smaller the better.
3. The version (npm tag or container SHA) you tested against.
4. Your preferred credit name and link (or a request to remain anonymous).

You can expect:

- An acknowledgement within **3 business days**.
- A triage decision and severity score (CVSS v3.1) within **7 business days**.
- A coordinated disclosure timeline — typically **30 days** for a fix to ship,
  longer only if the bug requires upstream changes.
- Credit in the release notes and (with consent) in any published advisory.

## Scope

In scope:

- `mcp-server/` — the MCP server itself, the Web UI, the `/api/*` endpoints,
  the `/mcp` transport.
- Connectors that ship with the server (Prometheus, Loki).
- The Helm chart at `helm/observability-mcp/`.
- Default Docker image at `ghcr.io/thotischner/observability-mcp`.

Out of scope (report to the respective upstream):

- Third-party connectors loaded as plugins.
- Vulnerabilities in `@modelcontextprotocol/sdk`, `express`, `hono`, Node.js itself.
- Configuration mistakes (e.g. running with `MCP_AUTH_TOKEN` unset on a public network).
- Findings from automated scanners without a working PoC.

## Hardening posture

The server is built with the following defaults:

- `npm audit --audit-level=high` is enforced in CI; transitive vulnerabilities
  in the MCP SDK are pinned via `npm overrides` (see [`project_cve_strategy`](docs/plugin-architecture.md) for the strategy).
- Container runs as a non-root user, no privilege escalation, all capabilities
  dropped, `seccompProfile: RuntimeDefault` via the Helm chart.
- npm publish uses `--provenance` so installers can verify build attestation.
- `tools/list` output is the source of truth; the server does not advertise
  features that aren't actually wired.

If you operate the server on the public internet, set `MCP_AUTH_TOKEN` and
front it with a reverse proxy that terminates TLS.

## Verifying releases

Every release artifact ships with build attestations so operators can verify
it came from this repository's CI before installing it.

### npm package — provenance attestation

```bash
# Verify the package was built by the published GitHub Actions workflow
npm view @thotischner/observability-mcp dist-tags
npm audit signatures @thotischner/observability-mcp
```

Provenance is also visible on the
[npm package page](https://www.npmjs.com/package/@thotischner/observability-mcp)
under the "Provenance" tab.

### Container image — GHCR + scanned

```bash
# Pull and inspect the source-commit label
docker pull ghcr.io/thotischner/observability-mcp:latest
docker image inspect ghcr.io/thotischner/observability-mcp:latest \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
```

CI scans every image with Trivy before publishing; high-severity CVEs block
the release.

### Helm chart — GPG-signed

The Helm chart is GPG-signed; the public key is committed at
[`docs/helm-signing.pub.asc`](docs/helm-signing.pub.asc) and the fingerprint
is advertised on ArtifactHub via the `artifacthub.io/signKey` annotation.

```bash
# Add the signing key to your keyring
curl -sS https://raw.githubusercontent.com/ThoTischner/observability-mcp/main/docs/helm-signing.pub.asc \
  | gpg --import

# Verify the .tgz + .prov pair before installing
helm verify ./observability-mcp-<version>.tgz
```

### MCP tool surface — `tools/list` is the contract

The server only advertises tools it actually implements. The integration
smoke test asserts the exact set of advertised tools on every PR (see
[`.github/workflows/integration.yml`](.github/workflows/integration.yml)).
If `tools/list` claims a tool, calling it does what the docs say. If a tool
name is missing from `tools/list`, it does not exist in that build.
