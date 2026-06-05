# MCP Products

A **Product** is a named, governed bundle of MCP capabilities you
expose to agents. It carries an id (the URL key + audit target), a
display name, an optional tool allowlist that downstream slices will
use to filter `tools/list` at the `/mcp` transport, branding
metadata (icon URL, theme colour), a lifecycle status
(`published` / `staging`), and an optional tenant. The whole catalog
lives in one operator-edited file — same posture as the service
catalog, the users file, and the RBAC policy file.

## Why

Once the server is wired into a real organisation, agents stop being
generic. Each team / product line wants its own curated bundle:

- "Ops Bundle" — for the SRE agent: `query_logs`, `query_metrics`,
  `get_service_health`. Excludes admin tools.
- "Dev Bundle" — for a coding agent: `list_services`, `get_topology`.
  No write paths, no logs.
- "Compliance Bundle" — for the audit agent: `query_logs` only,
  with `bypass_redaction` denied at the credential layer.

Each bundle gets shipped as a Product. Per-tenant isolation (E7)
ensures Acme's "Ops Bundle" never appears in BigCo's catalog.

## File shape

```yaml
# mcp-server/config/products.yaml — set OMCP_PRODUCTS_FILE=…
products:
  - id: ops-bundle
    name: Operations Bundle
    description: Incident-response tools for the on-call SRE agent.
    tools:
      - query_logs
      - query_metrics
      - get_service_health
    version: 1.2.0
    status: published          # published | staging
    branding:
      iconUrl: https://example.com/icons/ops.svg
      color: "#3178c6"

  - id: dev-bundle
    name: Developer Bundle
    description: Discovery + topology tools for the coding agent.
    tools:
      - list_services
      - get_topology
    status: staging            # admin-only — agents can't see it yet

  - id: acme-compliance
    name: Acme Compliance
    description: Read-only logs for the Acme compliance team's agent.
    tools: [query_logs]
    status: published
    tenant: acme               # E7: only visible to Acme-tenant callers
```

Validation rules (the loader rejects loudly, ENOENT silently — see
`docs/policy-engines.md` for the same pattern):

| Rule | Why |
|---|---|
| `id` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` | URL-safe, path-traversal safe |
| `name` non-empty string | UI display |
| `tools` optional string-array | `/mcp` `tools/list` filter — only the named tools register on a credential bound to this Product. Absent / empty list = no restriction. |
| `status` ∈ `{published, staging}` | Staging hidden from agents + non-admin viewers |
| `branding.iconUrl` / `branding.color` must be strings | Type guard |
| Duplicate `id` rejects loudly | Operator typo catch |
| Unknown top-level keys reject (`toolss:` → fail-loud) | Typo guard |

A malformed file fails CI at the test phase (`parseProductsText`
tests cover every reject path). On the server, a malformed file
aborts boot via the standard `authMisconfig` shape, identical to
RBAC / users-file failures.

## API

| Endpoint | Method | RBAC | Notes |
|---|---|---|---|
| `/api/products` | GET | `products:read` | Tenant + staging-aware. `?tenant=X` admin drill-down. |
| `/api/products` | POST | `products:write` | Strict create — 409 on conflict. Use when you want create-vs-update semantics. |
| `/api/products/:id` | GET | `products:read` | 404 on cross-tenant or staging probe by non-admin (no existence leak). |
| `/api/products/:id` | PUT | `products:write` | Upsert. Body validated through the same parser; persists to file when set. |
| `/api/products/:id` | DELETE | `products:delete` | 404 on cross-tenant; admin-only via DEFAULT_POLICY. |

Both POST + PUT enforce the **tools[] typo guard**: a Product whose
`tools` list names tools that don't actually register (e.g. a typo
`query_logz`) is rejected with **422** + `code:
OMCP_PRODUCT_UNKNOWN_TOOL` + the `unknown` names + the `available`
list. Without the guard, a bound credential would open an `/mcp`
session with an empty tool surface — silent dead session.

Default permission grants:

| Role | Permissions |
|---|---|
| `viewer` | `products:read` |
| `operator` | `products:read + write` |
| `admin` | `products:read + write + delete` |

Custom policies (`OMCP_RBAC_POLICY_FILE`) can redefine any of these
— see [policy-engines.md](policy-engines.md).

## Tenant scoping (E7 integration)

| Caller | Sees |
|---|---|
| Anonymous | `default`-tenant published products only |
| Basic / OIDC viewer | own-tenant published products only |
| Admin (default tenant) | every tenant's products + staging |
| Admin with `?tenant=acme` | drill-down to acme |

Cross-tenant probes (GET / DELETE on an id that exists in another
tenant) return **404** — same posture as the rest of the tenancy
layer, no existence leak.

## Binding an agent's `/mcp` session to a Product

Set `OMCP_KEY_PRODUCTS` to bind a named credential to one Product id:

```bash
OMCP_API_KEYS="agent:tok_ops,ci:tok_dev"
OMCP_KEY_PRODUCTS="agent=ops-bundle;ci=dev-bundle"
# (optionally pin each credential to a tenant)
OMCP_KEY_TENANTS="agent=acme;ci=acme"
```

When the `agent` credential opens an `/mcp` session, only the tools
listed in the `ops-bundle` Product's `tools` field are registered;
`tools/list` returns exactly that set. Unrecognised tool names are
silently skipped at registration time, so a typo in the YAML
narrows the surface rather than crashing the session.

Resolution is tenant-scoped: a credential bound to `ops-bundle` in
tenant `acme` cannot pick up a `ops-bundle` Product owned by tenant
`bigco` — the cross-tenant `get()` returns `undefined` and the
session falls back to the unrestricted set. This is the same posture
the rest of the tenancy layer enforces.

Anonymous `/mcp` sessions (no `OMCP_API_KEYS` configured) and
credentials with no `productId` see every registered tool — the
back-compat path the open-source default relies on.

The catalogue is read with hot-reload semantics: editing the
Product's `tools` list and re-saving the file takes effect on the
**next** `/mcp` session, no server restart needed. Live sessions
keep the snapshot they were created with.

## UI

The Products tab on the Web UI hosts a live table driven by
`/api/products`:

- **Scope badge** in the header — `scope: acme` / `scope: all
  tenants` / `scope: default · staging visible`.
- **Inline rows** — id (mono), name + description, tenant tag,
  status pill, first 5 tools + overflow count.
- **+ New product** (RBAC: `products:write`) — minimal two-prompt
  flow (id + name) creates a staging entry; edit the file directly
  for richer authoring.
- **Edit / Delete** row buttons (RBAC: `products:write` /
  `products:delete`) — hidden via `data-rbac` for non-admin
  sessions.

The legacy `/api/enterprise/catalog` block stays underneath the new
section so deployments on the old surface aren't disrupted; new
deployments should use only the new endpoints.

## Heavy authoring workflow

The UI prompt-driven flow is the MVP. For real-world catalogues
the recommended path is:

1. Check in `mcp-server/config/products.yaml` to git.
2. Open a PR for any change.
3. CI runs `parseProductsText` validation (via the loader test
   harness) and fails loudly on typos / unknown keys / duplicates.
4. Merge → server picks up the updated file on the next
   `/api/products*` request (mtime-poll hot-reload). No restart
   required. Parse errors keep the previous good catalogue in
   memory and log loudly, so a broken edit on disk never takes
   the running server down.

This keeps the catalog in the same review loop as code: every
product change has an author, a reason in the PR body, and a
revert path.

## Virtual MCP server endpoints (since v2.0 / Phase F9)

Every published Product is automatically exposed on its own
Streamable HTTP endpoint at `/mcp/v/<product-id>`. An MCP client
that connects there sees ONLY the tools bound to that Product —
the rest of the gateway's tool surface is invisible.

| Endpoint | Surface |
|---|---|
| `POST /mcp` | All tools (caller's allow-list still applies) |
| `POST /mcp/v/<id>` | Only the Product's `tools` (intersected with the caller's allow-list) |

### When to use

- **Hand a Product to one consumer**: pass them
  `https://gateway.example.internal/mcp/v/payments-rca` plus a
  credential, they configure their MCP client (Claude Desktop /
  Cursor / etc.) against the per-Product URL, and they see exactly
  the curated tool set you composed — no need to also issue them a
  `OMCP_KEY_PRODUCTS` binding.
- **Per-team curation**: one Product per agent crew, each crew
  pointing at its own URL.
- **Demos / kiosks**: a public endpoint with a tightly-scoped
  Product is safer than a broad `/mcp` with a key.

### Tenant + auth

The endpoint resolves the Product in the caller's tenant. A
cross-tenant lookup returns `404` (the same existence-hiding stance
the rest of the tenancy layer takes), so two tenants can both have
a Product called `rca` without seeing each other.

Sessions are bound to the Product they were issued under: a session
minted on `/mcp/v/foo` cannot be re-used to call `/mcp/v/bar`
(returns `404`). The session-id header is opaque to the client;
this binding is enforced server-side.

### Example

```bash
# Configure Claude Desktop:
{
  "mcpServers": {
    "payments-rca": {
      "url": "https://gateway.example.internal/mcp/v/payments-rca",
      "headers": { "Authorization": "Bearer <your-key>" }
    }
  }
}
```

The client's `tools/list` will return only the tools the Product
declares. Everything else (auth, rate limits, audit, tenancy)
behaves exactly like the root `/mcp` endpoint.

### Staging products

Products with `status: staging` are admin-only — their `/mcp/v/`
endpoint returns `404` to any caller, so you can stage a Product
and review it via `/api/products/:id` without making it reachable
to consumers.

## See also

- [access-control.md](access-control.md) — the wider RBAC + audit
  + redaction story Products plugs into.
- [policy-engines.md](policy-engines.md) — built-in / file / OPA
  policy engines that gate Products as much as any other resource.
- [tenancy.md](tenancy.md) — tenant identity resolution; Products
  inherits the same `tenant` field shape used everywhere else.
