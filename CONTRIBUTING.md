# Contributing

Thanks for thinking about it. Quick orientation so your first PR lands without churn.

## Before you start

- Browse the open issues and PRs. If you're tackling something non-trivial, open an issue first so we can align on the approach.
- Security reports do **not** go in a public issue — see [SECURITY.md](./SECURITY.md).
- Read [CLAUDE.md](./CLAUDE.md) for the local development workflow. Short version: **everything runs in Docker**, never `npm install` on the host.

## Project layout

```
mcp-server/   The product. Express + MCP Streamable HTTP, the Web UI, the connectors.
agent/        Demo: an Ollama-driven autonomous incident detector that talks to the server.
example-services/   Demo: three Node services with chaos endpoints, used by docker-compose for the POC.
helm/         Helm chart for k8s deployments. ArtifactHub-bound.
docs/         Architecture and operational docs.
```

The agent + example-services are demo material. They will be moved under `examples/` in a forthcoming refactor — until then, treat changes to them as non-shipping unless they're for the docker-compose demo to keep working.

## Workflow

1. **Fork + branch.** Branch names: `feat/...`, `fix/...`, `docs/...`, `ci/...`, `security/...`, `ui/...`. No emojis.
2. **Make it small.** A reviewer should be able to load the diff in their head. If you find yourself in two files for two unrelated reasons, that's two PRs.
3. **Tests.** Add or update them. The integration smoke spins up the whole docker-compose stack and exercises the MCP handshake end-to-end — your change needs to keep it green. See `.github/workflows/integration.yml`.
4. **Run locally.**
   ```bash
   docker-compose up --build       # full stack
   # unit tests
   docker run --rm -w /app -v "$(pwd)/mcp-server:/app" node:20-alpine \
     sh -c "npm install --silent && npx tsx --test src/analysis/*.test.ts src/config/*.test.ts"
   # helm chart
   docker run --rm -v "$(pwd)/helm/observability-mcp:/chart" alpine/helm:latest lint /chart
   ```
5. **Open the PR.** Title in the imperative — *"add fast-uri override"*, not *"added fast-uri override"*. Body says what + why; the code shows how.
6. **Required checks.** main is branch-protected: `smoke`, `unit-tests`, `npm-audit (mcp-server)`, `npm-audit (agent)`, `trivy`, `analyze (javascript-typescript)` all have to be green. Patch + minor PRs auto-merge once they are.

## Code style

- TypeScript strict mode. No `any` unless you also write a comment explaining why.
- Default to **no comments**. Add one only where the *why* would surprise the next reader — a workaround, a constraint, an invariant. Don't paraphrase the code.
- Validate at boundaries (user input, external APIs). Trust internal code.
- No backwards-compatibility shims unless you can't avoid them.

## Adding a connector

For now, drop a new `.ts` under `mcp-server/src/connectors/` and register the factory in `loader.ts` builtin shim. The proper path — separate npm package conforming to the [plugin architecture](./docs/plugin-architecture.md) — opens up after PR roadmap step 4 (SDK published to npm). Open an issue if you want to start work on that.

## Releases

Releases are automated. The weekly job opens a `chore(release): vX.Y.Z` PR with the version bump, GitHub auto-merges once green, the resulting commit on `main` triggers a tag push, and the tag triggers `release.yml` + `docker-publish.yml` + `npm-publish.yml`. You shouldn't tag anything manually.

If you need a release sooner than Sunday: `gh workflow run auto-release.yml` (maintainers only).
