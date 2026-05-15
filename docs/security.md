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

## Connector signing

Hub-distributed connectors (e.g. Datadog) ship a detached signature of
their `manifest.json` *inside* the tarball. The server and `omcp plugin
install/verify` check it fail-closed against a trust root — fully
offline, no transparency log (airgapped-safe).

- **Public key (trust root)**: [`docs/plugin-signing.pub.pem`](plugin-signing.pub.pem)
  (Ed25519). Operators pass it as `PLUGIN_TRUST_ROOT` / `--trust-root`.
- **Private key**: only the `PLUGIN_SIGNING_KEY_B64` repo secret (base64
  PKCS#8). CI-only, scoped to connector signing. Never in git.
- **Pipeline**: `.github/workflows/connector-publish.yml` runs
  `connectors/pack.mjs` (validates `manifest.integrity` ==
  sha256(entry), signs `manifest.json`, tars the dir) and uploads
  `<name>-<version>.tgz` to the `connector-<name>-<version>` release —
  the URL the hub catalog points at. Signing is fail-open (missing key
  → unsigned tarball; install then needs `--insecure`).
- **Verify manually**:
  ```bash
  omcp plugin verify ./plugins/datadog --trust-root docs/plugin-signing.pub.pem
  ```

### Rotation / revocation

The key has no expiry; rotate if exposure is suspected.

1. `node -e 'c=require("crypto");k=c.generateKeyPairSync("ed25519");
   require("fs").writeFileSync("docs/plugin-signing.pub.pem",
   k.publicKey.export({type:"spki",format:"pem"}));
   process.stdout.write(Buffer.from(k.privateKey.export({type:"pkcs8",
   format:"pem"})).toString("base64"))'` → set the output as
   `PLUGIN_SIGNING_KEY_B64`.
2. Commit the regenerated `docs/plugin-signing.pub.pem`, bump connector
   versions, re-run the publish workflow. Already-published tarballs
   stay verifiable with the previous public key from git history.

## Helm chart signing

Released Helm charts are GPG-signed. Each `observability-mcp-X.Y.Z.tgz` ships
with a matching `.tgz.prov` provenance file, and ArtifactHub shows the
"signed" badge.

- **Public key**: [`docs/helm-signing.pub.asc`](helm-signing.pub.asc) (also
  referenced by `artifacthub.io/signKey` in `helm/observability-mcp/Chart.yaml`).
- **Private key**: held only as the `HELM_SIGNING_KEY_B64` /
  `HELM_SIGNING_KEY_PASSPHRASE` repository secrets. It is a dedicated,
  CI-only key — it signs nothing but charts and is never used locally.
- **Verify a release**:
  ```bash
  helm pull observability-mcp/observability-mcp --prov
  gpg --import docs/helm-signing.pub.asc
  helm verify observability-mcp-*.tgz
  ```

### Key rotation / revocation

The signing key has no expiry, so rotation is manual. Rotate immediately if
the private key (or its passphrase) is suspected exposed; otherwise rotate
on a routine cadence.

1. Generate a fresh key (RSA 4096, empty or stored passphrase):
   `gpg --batch --gen-key` with a `Name-Real: observability-mcp helm signing`.
2. Export and update the **secrets**:
   `gpg --export-secret-keys <fpr> | base64 -w0` → `HELM_SIGNING_KEY_B64`;
   update `HELM_SIGNING_KEY_PASSPHRASE` to match (empty if none).
3. Export the **public key** over the old one:
   `gpg --armor --export <fpr> > docs/helm-signing.pub.asc`.
4. Update the fingerprint in `helm/observability-mcp/Chart.yaml`
   (`artifacthub.io/signKey.fingerprint`), bump the chart `version`, and
   open a PR. The next publish signs with the new key; older releases stay
   verifiable with the previous public key from git history.
5. **Revocation**: generate and publish a revocation certificate for the
   retired key (`gpg --gen-revoke <fpr>`), and note the retirement date in
   `CHANGELOG.md`. Already-published `.prov` files remain valid against the
   archived public key; only future releases use the new key.

The CI signing step is best-effort and fail-open: if the key is missing or
unimportable the chart still publishes (unsigned), and gpg error detail is
kept out of the public Actions log.

## Token / secret handling

- Do not bake secrets into `sources.yaml`. Use `${VAR}` substitution and supply them via env or a `.env` file.
- The container reads `sources.yaml` from a mounted volume — nothing about credentials lives in the image layer.
- GitHub repository secrets used by CI: `NPM_TOKEN` (npm publish), `RELEASE_PAT` (lets the auto-release tag push trigger downstream workflows). Both are injected only into the workflows that need them.
