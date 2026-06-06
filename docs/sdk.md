# Plugin SDK — \`@thotischner/observability-mcp-sdk\`

The SDK is the public, npm-published surface plugin authors depend
on. It mirrors `mcp-server/src/sdk/` exactly so authoring a
connector or a lifecycle hook never requires cloning the gateway.

## Install

```bash
npm install @thotischner/observability-mcp-sdk
```

## Surface

```ts
import {
  manifestSchema,                  // Zod schema for plugin manifest.json
  HookRegistry,                    // tool / resource / prompt hook fan-out
  type ObservabilityConnector,     // implement this on your connector class
  type HookKind,
  type HookContext,
  type HookPayload,
  type HookResult,
  type ValidatedConnectorManifest,
} from "@thotischner/observability-mcp-sdk";
```

## Scaffolder CLI

```bash
npx @thotischner/observability-mcp-sdk create-connector my-connector
```

Drops a working skeleton at `./my-connector/` with `manifest.json`,
`package.json`, `src/index.ts` (implementing
`ObservabilityConnector`), `src/index.test.ts`, and a starter
README. Tests pass on first run.

## Compatibility

The SDK version-tracks the gateway: SDK `2.x` works with
observability-mcp `2.x`. The manifest's `schemaVersion` is the
authoritative compat marker — bumping it is a breaking change for
plugin authors and is documented in the
[plugin architecture](plugin-architecture.md) page.

## Vendored vs canonical source

The package vendors two source files (`hooks.ts`,
`manifest-schema.ts`) from `mcp-server/src/sdk/`. A CI parity check
fails the SDK publish workflow if they drift. The longer-term plan
(F20b) flips the relationship via npm workspaces so mcp-server
imports from the SDK package instead — at that point the
duplication disappears.

## Publishing

The `sdk-publish` workflow fires on tags shaped like `sdk-v2.0.0`.
It runs the parity check, builds + packs, then publishes to npm
with provenance attestation.

## Related

- [Plugin architecture](plugin-architecture.md) — manifest contract, hook lifecycle, signing
- [Dev loop](dev-loop.md) — how to iterate on a new connector inside the monorepo
