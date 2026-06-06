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

## License

Apache-2.0
