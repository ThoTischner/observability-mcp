# Connector plugin architecture

Status: design — implementation tracked in [#46+]
Last updated: 2026-05-14

## Goals

1. **Connectors are optional.** The MCP server starts and serves `tools/list` with zero connectors; users add Prometheus, Loki, Tempo, OpenSearch, Datadog, etc. on demand.
2. **No build needed to add a connector.** Drop a tarball / npm package into the right place, point a config line at it, restart. No code changes to the server.
3. **Airgapped works.** No runtime network access required to load a connector. All resolution from local filesystem or the container image.
4. **Versioned, signed, discoverable.** A *connector hub* — a curated registry of connector packages with signed manifests — hosts the catalog; the CLI can install from the hub or a private mirror.
5. **Backwards compatible during rollout.** The existing `PrometheusConnector` and `LokiConnector` keep working through a builtin-shim before they get extracted into separate packages.

## Non-goals (for v1)

- Hot-reload of connector code without server restart. (Stretch goal — possible with `vm.Module` but adds complexity.)
- Multi-language connectors. The plugin contract is JavaScript/TypeScript; non-JS backends still get connectors written in TS that wrap their HTTP API. (This may change with the connector hub.)
- A separate sandboxed permission model per connector. Connectors run in the same process and trust the server.

## The contract

A connector plugin is an npm package (or directory) that:

1. Has a `package.json` with the field
   ```json
   "observabilityMcp": {
     "kind": "connector",
     "name": "prometheus",
     "manifest": "./manifest.json"
   }
   ```
   The `name` is the unique connector type id used in `sources.yaml` (`type: prometheus`).

2. Ships a `manifest.json` declaring metadata used by the server and the hub UI:
   ```json
   {
     "schemaVersion": 1,
     "name": "prometheus",
     "displayName": "Prometheus",
     "version": "1.0.0",
     "description": "PromQL-based metrics backend.",
     "signalTypes": ["metrics"],
     "homepage": "https://github.com/.../connector-prometheus",
     "license": "MIT",
     "logo": "./logo.svg",
     "configSchema": {
       "$schema": "https://json-schema.org/draft/2020-12/schema",
       "type": "object",
       "required": ["url"],
       "properties": {
         "url":  { "type": "string", "format": "uri" },
         "auth": { "$ref": "#/$defs/auth" }
       }
     },
     "capabilities": {
       "queryMetrics": true,
       "queryLogs":    false,
       "listServices": true
     },
     "compat": {
       "serverVersion": ">=1.4.0"
     }
   }
   ```

3. Exports a default factory:
   ```ts
   import type { ObservabilityConnector } from "@thotischner/observability-mcp/sdk";

   export default function createConnector(): ObservabilityConnector {
     return new PrometheusConnector();
   }
   ```
   The factory is async-tolerant; the server `await`s it.

4. (Optional) Ships an integration test that the hub can run before publishing:
   ```
   npm test  # exits 0 if the connector can connect/disconnect against a recorded mock
   ```

The server's existing `ObservabilityConnector` TypeScript interface stays the source of truth and is published as `@thotischner/observability-mcp/sdk` so plugin authors don't pull in the whole server.

## Loading mechanism

The server has three loading sources, applied in order. Higher in the list wins on name collision.

1. **Builtin shim** — for v1 only. The shim exposes `prometheus` and `loki` as if they were external plugins. Lets us roll out the plugin layer first, then extract the two connectors in a follow-up PR with zero user-facing change.

2. **Filesystem plugins** — the server scans `${PLUGINS_DIR:-/app/plugins}` at startup for sub-directories containing a `package.json` with the `observabilityMcp` marker. This is the canonical install path for:
   - **Air-gapped deployments** — operator copies the tarball into the image at build time or mounts a ConfigMap-extracted dir.
   - **Helm chart** — the chart's `values.yaml` will accept a `plugins:` list that mounts each as an init-container-extracted volume.

3. **`plugins:` block in `sources.yaml`** — optional, for explicit pinning when the dir scan would otherwise pick up the wrong version:
   ```yaml
   plugins:
     - name: prometheus
       version: 1.2.0       # picks /app/plugins/prometheus-1.2.0 over a bare prometheus dir
   ```

The order matters because air-gapped users typically pre-stage `/app/plugins` and want the server to honor that without writing config.

A registered plugin is just a row in a `Map<string, { factory: () => Connector, manifest: Manifest }>`. The existing `connectorFactories` map in `registry.ts` gets replaced by this loader's output.

## Air-gapped: how it actually works

The pain point of airgapped setups is **no `npm install` at runtime**, no GitHub access, no registry. The plugin architecture exists in large part to solve this cleanly.

Three supported workflows:

- **Bundled image.** CI publishes an official multi-connector image — `ghcr.io/thotischner/observability-mcp-plugins:latest` (`.github/workflows/connector-bundle-image.yml`; connectors signed with the same key as the hub tarballs). Operators just reference or mirror it — no hand-built image.

- **Mounted volume (k8s).** The Helm chart accepts:
  ```yaml
  plugins:
    image: ghcr.io/thotischner/observability-mcp-plugins:latest   # official signed bundle (or a mirror)
    paths:
      - prometheus
      - loki
      - tempo
  ```
  This translates into an init container that extracts the listed paths from the plugin image into an `emptyDir` mounted at `/app/plugins`. No registry access from the main container.

- **Sideloaded tarballs.** For VM / bare-metal deployments, operators `wget <url>` the connector tarball, `tar -xzf` into `/app/plugins/`, restart. The tarball is a published `*.tgz` from the hub (or a mirror) — the same format `npm pack` produces. Or, with `ENABLE_UI_INSTALL=true` + a trust root, drag the same `.tgz` into the Web UI's **Connectors → Upload a connector bundle** (no shell access needed).

### Verification (airgapped trust root)

Plugin verification is **fully offline** — no Fulcio/Rekor, no cosign binary, no network. That is a deliberate choice: a sigstore keyless flow needs to reach a transparency log, which an airgapped site cannot. Instead the server checks a local trust root with Node's built-in crypto.

A plugin is loaded only when **both** hold:

1. **Integrity.** The plugin's `manifest.json` carries an `integrity` field — `sha256-<base64>` of the entry file — and it matches the on-disk entry.
2. **Authenticity.** A detached signature `manifest.json.sig` (sibling of the manifest) verifies the raw manifest bytes against the configured trust-root public key. Ed25519 and RSA/EC PEM keys are supported; the `.sig` may be raw DER or base64-armored.

Because the signature covers the manifest and the manifest pins the entry-file hash, signing the manifest transitively authenticates the code.

| Setting | Env | Default | Meaning |
|---------|-----|---------|---------|
| Verify  | `VERIFY_PLUGINS` | off | When `true/1/yes`, filesystem plugins are gated. |
| Trust root | `PLUGIN_TRUST_ROOT` | — | Path to the PEM public key. |

**Fail-closed.** With `VERIFY_PLUGINS=true` and no/invalid trust root, *no* filesystem plugin loads (builtin Prometheus/Loki, part of the trusted image, are never gated, so the server stays functional). Any plugin missing a manifest, signature, or failing either check is skipped with a logged reason — it is never loaded "best effort".

Producing the artifacts (offline, from the connector dir):

```bash
node -e 'const{createHash}=require("crypto"),fs=require("fs");
  const h="sha256-"+createHash("sha256").update(fs.readFileSync("index.js")).digest("base64");
  const m=JSON.parse(fs.readFileSync("manifest.json"));m.integrity=h;
  fs.writeFileSync("manifest.json",JSON.stringify(m,null,2)+"\n")'
openssl pkeyutl -sign -inkey signing.key -rawin -in manifest.json | base64 > manifest.json.sig
```

The operator distributes only the **public** key as `PLUGIN_TRUST_ROOT`. The Helm chart wires `plugins.verify` (sets `VERIFY_PLUGINS=true` and mounts the trust root for any non-builtin plugin) and `plugins.uiInstall` (sets `ENABLE_UI_INSTALL`); the trust root is rendered/mounted whenever verification *or* runtime install is enabled. The connector hub publishes the same `integrity` + detached signature per release, so the hub CLI and the Web UI install path reuse this exact check.

## The connector hub

The catalog contract lives in-repo at [`hub/`](../hub/README.md): a
schema-validated `catalog/<name>.json` per connector aggregated into a
static `catalog/index.json` (CI keeps it in sync). It is **live** today:

- **Static catalog** (think `helm/charts` repo): each connector's manifest, signed tarball URL, versions, and changelog live as `hub/catalog/<name>.json`; `hub/build-catalog.mjs` validates and aggregates them. Telemetry-free — the hub serves static files, no install pingback. The hub *publishes* tarballs but does not host the server; operators can mirror the whole catalog into their own static-file CDN with a single rsync.
- **Hosted site** at <https://thotischner.github.io/observability-mcp/hub/> — an ArtifactHub-style browser: clickable connectors, per-connector detail pages with a version table and copy-paste install boxes for every scenario (omcp CLI / air-gapped / Helm / manual).
- **omcp CLI**: `omcp plugin list|info|install|verify` resolves the catalog (`--from <dir|url>` for air-gapped), verifies the signature, and extracts into `${PLUGINS_DIR}/<name>/`. See the CLI section in the main README.
- **Web UI Connectors page** + JSON API on the running server (next section).

### Runtime install from the running server (Web UI / API)

The server exposes the hub directly so operators can manage connectors without a redeploy:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/connectors` | Installed connectors (builtin + filesystem) with manifest info. |
| `GET /api/hub/catalog` | The hub catalog, server-proxied, merged with what's installed (`HUB_CATALOG_URL` overrides the source). |
| `POST /api/connectors/install` | Install a connector by name from the catalog (downloads only catalog `tarballUrl`s — no arbitrary URL, avoids SSRF). |
| `POST /api/connectors/upload` | Install an uploaded connector `.tgz` (raw `application/octet-stream`) — for air-gapped operators with no catalog reach. |

Both install paths run the **exact same fail-closed verification** as the loader and the CLI (signature + integrity against `PLUGIN_TRUST_ROOT`), then persist into `PLUGINS_DIR` and re-scan the loader.

**Guardrails** — runtime code-load is powerful, so it is doubly gated and off by default:

| Setting | Env | Default | Meaning |
|---------|-----|---------|---------|
| Enable UI install/upload | `ENABLE_UI_INSTALL` | off | Both endpoints return `403` unless this is `true`. |
| Trust root | `PLUGIN_TRUST_ROOT` | — | Required (`412` otherwise) — the server refuses to install unverified code, even when `VERIFY_PLUGINS` is off. |

A tampered/unsigned bundle is rejected (`400`, `PluginVerificationError`) and never written. On Kubernetes, `PLUGINS_DIR` is an `emptyDir` reseeded from the bundle image on every start, so set `plugins.persistence.enabled=true` (PVC) and `plugins.uiInstall.enabled=true` in the Helm chart for runtime-installed connectors to survive pod restarts.

Future: a "third-party / certified / official" rating tier for catalog entries.

## Implementation milestones

These will be separate PRs so each can pass smoke independently:

| PR | Scope |
|----|-------|
| 1  | Extract `ObservabilityConnector` and types into `mcp-server/src/sdk/` and re-export. No behavior change. |
| 2  | Replace `registry.ts:connectorFactories` with a `PluginLoader` that walks builtin → filesystem → config-pinned. Builtin shim wraps current prometheus/loki connectors. |
| 3  | Add `PLUGINS_DIR` env, document it. Plugin scan + manifest validation against a Zod schema. Per-plugin enable/disable. |
| 4  | Publish `@thotischner/observability-mcp-sdk` to npm. Move the prometheus connector into its own package, mark the shim as deprecated. |
| 5  | Loki connector → own package. |
| 6  | ✅ Offline verification (`VERIFY_PLUGINS` + local trust root) — fail-closed manifest signature + entry integrity. (Local trust root, not sigstore: airgapped sites can't reach a transparency log.) |
| 7  | ✅ Helm `plugins.image` + init-container extraction, plus an official signed multi-connector bundle image (`observability-mcp-plugins`) so no image build is needed. |
| 8  | ✅ Catalog contract in `hub/` (schema + validated `index.json` + generator + CI). |
| 9  | ✅ Hosted hub site (GitHub Pages, ArtifactHub-style detail pages) + `omcp` CLI (`plugin list/info/install/verify`, `--from` for air-gapped). |
| 10 | ✅ Web UI Connectors page + JSON API: list installed, browse hub, server-side install from catalog, upload a bundle `.tgz` — all behind `ENABLE_UI_INSTALL` + trust root, fail-closed. |
| 11 | ✅ Helm `plugins.persistence` (PVC for `/app/plugins`) + `plugins.uiInstall` so runtime-installed connectors survive pod restarts. |

The first three PRs unlock airgapped deployments. Everything after is incremental polish — milestones 1–11 are complete.

## Open questions

- **Plugin process model.** Same-process for v1. Re-evaluate if a malicious connector becomes a real threat — could move to worker_threads with a message-passed adapter; needs cost/benefit analysis.
- **Versioning.** Manifest declares `compat.serverVersion`. We need a clear deprecation policy if/when the connector interface changes.
- **Permissions.** Should a connector be able to read environment variables freely? For airgapped customers with strict separation this is a question; default-allow for v1, tighten later if there's demand.
- **Tool-level extensibility.** Connectors are scoped to backends. Pure tool extensions (e.g. a `slack_notify` tool) belong in a separate plugin kind (`kind: "tool"`) — out of scope for v1.

Feedback welcome on the PR.
