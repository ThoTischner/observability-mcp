# Connector hub catalog

**Live site:** https://thotischner.github.io/observability-mcp/hub/
(deployed by `.github/workflows/hub-pages.yml` into the `gh-pages`
`/hub/` subtree — the Helm chart repo at the gh-pages root is untouched).

A **static** catalog of observability-mcp connectors (think the `helm/charts`
index, or Confluent Hub). No server, no telemetry: a single
`catalog/index.json` that a static site or the future
`observability-mcp install <name>` CLI fetches. Tarballs and signatures
are pulled directly from the URLs in each entry and verified with the
same trust-root model the server uses (see
[`../docs/plugin-architecture.md`](../docs/plugin-architecture.md)).

## Layout

```
hub/
├── catalog-schema.json     # JSON Schema for one catalog entry
├── catalog/
│   ├── <name>.json         # one file per connector (source of truth)
│   └── index.json          # generated, do not hand-edit
├── build-catalog.mjs       # validate + (re)generate index.json
└── build-catalog.test.mjs  # node --test
```

## Adding / updating a connector

1. Add or edit `catalog/<name>.json` (filename must equal the entry
   `name`). Validate against `catalog-schema.json`. Newest version first.
2. Regenerate the index:
   ```bash
   node hub/build-catalog.mjs
   ```
3. Commit both the entry and `catalog/index.json`. CI runs
   `node hub/build-catalog.mjs --check` and the test suite — a stale
   `index.json` or invalid entry fails the build.

Each version pins `integrity` (sha256 of the plugin entry file) and a
`signatureUrl` (detached signature of the manifest). An installer is
expected to verify both before loading — verification is offline and
mirror-friendly, so airgapped sites can `rsync` the whole `hub/` tree.

## Tiers

- **official** — maintained in this repo.
- **certified** — third-party, reviewed by maintainers.
- **third-party** — community, unreviewed; installers should warn.

The two builtin connectors (Prometheus, Loki) are listed with
`"builtin": true` for discoverability — they ship in the server image
and need no install step.
