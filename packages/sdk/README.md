# @thotischner/observability-mcp-sdk

Plugin SDK for [observability-mcp](https://github.com/ThoTischner/observability-mcp).

```bash
# Scaffold a new connector skeleton
npx @thotischner/observability-mcp-sdk create-connector my-connector

# Or add the SDK to an existing plugin:
npm install @thotischner/observability-mcp-sdk
```

## Surface

```ts
import {
  manifestSchema,            // Zod schema for plugin manifest.json
  HookRegistry,              // tool / resource / prompt lifecycle hooks
  type ObservabilityConnector,
  type HookKind,
  type HookContext,
  type HookPayload,
  type HookResult,
  type ValidatedConnectorManifest,
} from "@thotischner/observability-mcp-sdk";
```

See <https://thotischner.github.io/observability-mcp/plugin-architecture/>
for the full plugin contract.

## Compatibility

Version-tracks the parent gateway. SDK `2.x` works with
observability-mcp `2.x`; the manifest `schemaVersion` is the
authoritative compat marker — see
[`docs/plugin-architecture.md`](https://github.com/ThoTischner/observability-mcp/blob/main/docs/plugin-architecture.md).

## Source layout (for contributors)

This package vendors two files from the gateway's canonical in-tree
SDK so the published types stay byte-identical to what the server
actually enforces:

| file | source of truth |
|---|---|
| `src/hooks.ts` | `mcp-server/src/sdk/hooks.ts` (canonical) |
| `src/manifest-schema.ts` | `mcp-server/src/sdk/manifest-schema.ts` (canonical) |
| `src/index.ts` | package-specific (re-export barrel + npm header) |
| `src/cli/` | package-specific (the `create-connector` scaffolder) |

After editing either canonical file, run **`make sdk-sync`** to
regenerate the mirror, then commit both. The `sdk-publish` workflow
runs the same `diff -q` parity check (`make sdk-parity`) as a required
gate, so a forgotten sync can't ship.

> The gateway is **not** wired to import this package as a workspace
> dependency: `mcp-server` builds in an isolated Docker context
> (`COPY mcp-server/ .`) and the project is Docker-first (no host
> `npm install`), so a monorepo workspace link would add build-context
> coupling for no runtime gain. Vendoring + the parity gate is the
> deliberate trade.

## License

Apache-2.0
