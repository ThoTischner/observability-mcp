# enterprise/

Source-available modules licensed under the **Functional Source License,
Version 1.1, Apache 2.0 Future License** (`FSL-1.1-Apache-2.0`) — see
[`LICENSE`](./LICENSE). Each file converts to Apache-2.0 two years after it is
made available.

This directory is **not** part of the open-source distribution:

- It lives outside `mcp-server/`, whose npm package only publishes
  `["dist","config"]`, so it is never in the published tarball.
- The container build context is `./mcp-server`, so it is never in the
  Docker image.

The Apache-2.0 core in `mcp-server/` runs fully standalone without anything
here. These modules are optional and load only when explicitly wired in by an
operator.

## Modules

| Module | What it does |
|--------|--------------|
| [`rbac/`](./rbac) | Role-based access control: a pure policy evaluator + an enforcement guard that maps a request's principal/roles to an allow/deny decision over tools, sources, and services. Default-deny. |
| [`catalog/`](./catalog) | Governed product catalog: publish named **products** (curated bundles of sources/services/tools) and **grants** of products to principals; pure evaluator + enforcement guard. Default-deny. Composes with `rbac/` (both must allow). |

## Integration contract

`rbac/` is dependency-free ESM and duck-typed against the core
`RequestContext` shape (`{ principalId, auth, allowedSources?, ... }`) so the
Apache core never imports FSL code. An operator wires it at the context seam:
resolve the principal's roles, then call `enforce(...)` before a tool runs.

## Tests

```
node --test enterprise/rbac/*.test.mjs
```
