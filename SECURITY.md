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

### Container image — GHCR + scanned + cosign-signed + Syft SBOM

```bash
# Pull and inspect the source-commit label
docker pull ghcr.io/thotischner/observability-mcp:latest
docker image inspect ghcr.io/thotischner/observability-mcp:latest \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
```

CI scans every image with Trivy before publishing; high-severity CVEs block
the release.

**Keyless cosign signing.** Every image is signed via Sigstore keyless OIDC
(no operator-managed key material). Verify against the GitHub Actions
workflow identity:

```bash
cosign verify \
  --certificate-identity-regexp "^https://github\.com/ThoTischner/observability-mcp/\.github/workflows/docker-publish\.yml@refs/" \
  --certificate-oidc-issuer    "https://token.actions.githubusercontent.com" \
  ghcr.io/thotischner/observability-mcp:latest
```

**SBOM attestations.** CycloneDX-JSON + SPDX-JSON SBOMs (Syft-generated, in
addition to the buildx-embedded SBOM) are attached as cosign attestations,
**per platform** — one CycloneDX + one SPDX predicate is bound to each
per-platform digest in the manifest list. Resolve the platform digest
first, then verify:

```bash
IMAGE=ghcr.io/thotischner/observability-mcp:latest

# Pick the platform you actually run (linux/amd64 or linux/arm64).
PLATFORM=linux/amd64
PER_PLATFORM_DIGEST=$(docker buildx imagetools inspect --raw "$IMAGE" \
  | jq -r --arg p "$PLATFORM" '
      .manifests[] | select((.platform.os + "/" + .platform.architecture) == $p) | .digest')

# CycloneDX
cosign verify-attestation \
  --type cyclonedx \
  --certificate-identity-regexp "^https://github\.com/ThoTischner/observability-mcp/\.github/workflows/docker-publish\.yml@refs/" \
  --certificate-oidc-issuer    "https://token.actions.githubusercontent.com" \
  "ghcr.io/thotischner/observability-mcp@${PER_PLATFORM_DIGEST}" \
  | jq -r '.payload | @base64d | fromjson | .predicate' > image-sbom.cdx.json

# SPDX
cosign verify-attestation \
  --type spdxjson \
  --certificate-identity-regexp "^https://github\.com/ThoTischner/observability-mcp/\.github/workflows/docker-publish\.yml@refs/" \
  --certificate-oidc-issuer    "https://token.actions.githubusercontent.com" \
  "ghcr.io/thotischner/observability-mcp@${PER_PLATFORM_DIGEST}" \
  | jq -r '.payload | @base64d | fromjson | .predicate' > image-sbom.spdx.json
```

> Per-platform coverage: Syft scans both the amd64 and arm64 variants
> on the amd64 runner via the `--platform` flag (it pulls the right
> layer set from the manifest list) and attaches the resulting SBOMs
> as cosign attestations on the matching per-platform digest. The
> buildx-embedded SBOM remains as well, for tools that read attached
> SBOMs from the image directly.

The raw SBOM files are also uploaded as workflow artifacts on each release
(90-day retention), so an air-gapped operator can pull them from the
[GitHub Actions run](https://github.com/ThoTischner/observability-mcp/actions)
page without round-tripping cosign.

**SLSA provenance attestation.** buildx attaches SLSA-level provenance
(`mode=max`) to the OCI image; cosign also verifies that:

```bash
cosign verify-attestation \
  --type slsaprovenance \
  --certificate-identity-regexp "^https://github\.com/ThoTischner/observability-mcp/\.github/workflows/docker-publish\.yml@refs/" \
  --certificate-oidc-issuer    "https://token.actions.githubusercontent.com" \
  ghcr.io/thotischner/observability-mcp:latest
```

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

> **Roadmap.** A cosign-signed OCI chart variant is on the deferred
> list — once the chart is also pushed as an OCI artifact to GHCR
> via `helm push`, the same `cosign verify --certificate-identity-…`
> pattern that covers the image will apply to the chart. Until then,
> the GPG signature above is the authoritative verification path.

### MCP tool surface — `tools/list` is the contract

The server only advertises tools it actually implements. The integration
smoke test asserts the exact set of advertised tools on every PR (see
[`.github/workflows/integration.yml`](.github/workflows/integration.yml)).
If `tools/list` claims a tool, calling it does what the docs say. If a tool
name is missing from `tools/list`, it does not exist in that build.
