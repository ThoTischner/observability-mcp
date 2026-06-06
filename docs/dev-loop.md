# Dev loop

How to iterate on the gateway efficiently.

## Run the demo

```bash
docker compose --profile demo up --build
```

Brings up k3s + Prometheus + Loki + the three chaos services +
the gateway. Edit, save, the dev server restarts; the demo stack
keeps running.

Stop with `docker compose --profile demo down`.

## Local hot-reload

`mcp-server/` runs `npm run dev` under tsx watch — every save
restarts the server. The Web UI is a single HTML file at
`mcp-server/src/ui/index.html`; reload the browser tab to pick up
edits.

## Add a tool

1. Define the handler in `mcp-server/src/tools/<your-tool>.ts`.
   Follow the pattern from `query-logs.ts`:
   - export an `inputSchema` JSON-Schema object
   - export an async handler that returns
     `{ content: [...], isError: false }` (always include
     `isError: false` on the success path so strict tsc accepts
     the union of return shapes).
2. Add the tool name to **both** arrays in
   `mcp-server/src/tools/registry-names.ts`. A test enforces the
   1:1 mapping with `registerTool()` call sites in `index.ts`.
3. Register the handler in `mcp-server/src/index.ts` inside
   `createMcpServer` — copy the shape of the `query_traces` block:
   - `enforceEntitledAccess` (RBAC + Product gate)
   - `withToolMetrics` (Prometheus counter + latency)
   - `chargeTokenBudget` (per-identity quota)
4. Add unit tests in `tools/<your-tool>.test.ts` (`node:test`
   + `assert/strict`). A FakeRegistry / FakeConnector shape lives
   in most existing test files — crib it.
5. Run locally:
   ```bash
   docker run --rm -w /app -v "$(pwd)/mcp-server:/app" node:20-alpine \
     sh -c "npm install --silent && npx tsx --test src/tools/<your-tool>.test.ts"
   ```

## Add a connector

1. New file at `mcp-server/plugins/<your-connector>/`:
   - `manifest.json` per
     [`docs/plugin-architecture.md`](plugin-architecture.md)
   - implementation file(s)
2. Implement the `ObservabilityConnector` interface from
   `@thotischner/observability-mcp/sdk`. Optional methods to add
   based on capability:
   - `queryMetrics?` (metrics signal)
   - `queryLogs?` (logs signal)
   - `queryTraces?` (traces signal — Phase F13+)
   - `listResources?` / `listEdges?` / `getTopologySnapshot?` /
     `watchTopology?` (topology signal)
3. The loader picks it up on next boot when the plugin tarball is
   in `/app/plugins`. For signed-plugin testing see
   [`docs/plugin-architecture.md`](plugin-architecture.md#verification-airgapped-trust-root).

## Run the conformance harness

Boot the demo, then:

```bash
make conformance
```

Runs `mcp-server/src/conformance/mcp-2025-11-25.test.ts` against
the live `/mcp` endpoint. CI runs the same target on every PR.

## Run the full test suite

```bash
docker run --rm -w /app -v "$(pwd)/mcp-server:/app" node:20-alpine \
  sh -c "npm install --silent && find src -name '*.test.ts' -print0 | xargs -0 npx tsx --test"
```

This mirrors what CI runs.

## Reviewer-agent gate before push

The sprint plan requires every PR to clear a reviewer-agent gate
(quality + sensitive-data scan) before push. Catching things like
"oh that test fake didn't implement the full interface" pre-push
is dramatically cheaper than catching it from a red CI build.

## Playground tab (planned)

A built-in playground tab that mirrors Inspector inline is on the
F18b list — until it lands, use the actual Inspector via the
[Quickstart](quickstart-inspector.md).
