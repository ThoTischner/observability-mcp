# Multi-tenancy

Single-tenant by default — every existing OMCP deployment continues to
work without setting any `OMCP_*TENANT*` env vars. Anonymous principals,
local users without a `tenant` field, OIDC sessions without
`OMCP_OIDC_TENANT_CLAIM`, and MCP credentials without
`OMCP_KEY_TENANTS` all land in the universal `default` tenant. That's
the pre-E7 world.

Once an operator opts in via any of those knobs, OMCP becomes
multi-tenant: per-identity rate-limiter buckets, token-budget buckets,
audit entries, and catalog enrichments all scope by tenant. Cross-
tenant data is invisible to non-admins through both the `/api/*`
surface and the MCP tool layer.

## How identities resolve to a tenant

| Identity path | Tenant comes from | Default when unset |
|---|---|---|
| Anonymous | n/a | `default` |
| Basic-mode local user | `tenant` field on the user file entry | `default` |
| OIDC session | `OMCP_OIDC_TENANT_CLAIM` dotted-path claim | `default` |
| MCP bearer credential | `OMCP_KEY_TENANTS="name=tenant;..."` env | `default` |

The tenant identifier is normalised to `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` —
strictly lowercased, trimmed, traversal-safe. Invalid claims silently
fall back to `default` (the audit chain still records the actual
identity, but the tenant is sanitised). The regex is a strict superset
of RFC 1123 k8s namespace identifiers — any valid k8s namespace passes.

## Per-identity storage

Both per-identity surfaces use a composite `<tenant> <principalId>`
key internally:

- **Rate limiter** (`OMCP_TOOL_RATE_PER_MIN`): two credentials named
  `agent` in tenants `acme` and `bigco` get independent per-minute
  buckets.
- **Token budget** (`OMCP_TOOL_DAILY_TOKENS`): same.

The surface field stays unchanged: `/api/usage` continues to return
`actor: "agent"` (split out from the composite) plus a new
`tenant: "acme"` column. Existing tooling reading `actor`/`count`/
`limit`/`windowMs`/`tokens` is unaffected.

## Audit chain

Every recorded entry carries a `tenant` field. Pre-E7 entries default
to `"default"` when filtered. `/api/audit?tenant=acme` filters; non-
admins (without `users:delete`) are silently scoped to their own
tenant — they cannot read another tenant's audit history.

## Service catalog

`ServiceCatalogEntry.tenant` is optional. When set, the entry is only
surfaced to callers in that tenant — through `/api/catalog`,
`/api/services`, `/api/health{,/:service}`, and the `list_services` /
`get_service_health` MCP tool enrichers. Pre-E7 catalog files without
a `tenant` field on entries continue to enrich `default`-tenant
callers (i.e., pre-E7 deployments).

```yaml
# config/catalog.yaml — multi-tenant example
services:
  acme-payments:
    owner: team-payments
    tier: tier-1
    onCall: https://acme.pagerduty/team-payments
    tenant: acme
  bigco-payments:
    owner: bigco-platform
    tier: tier-2
    tenant: bigco
  shared-cdn:
    owner: infra
    # no tenant → default → visible to anonymous / single-tenant callers
```

## Cross-tenant API model

| Endpoint | Non-admin behaviour | Admin (`users:delete`) behaviour |
|---|---|---|
| `/api/audit` | scoped to own tenant | all tenants by default; `?tenant=X` to drill down |
| `/api/usage` | scoped to own tenant | all tenants by default; `?tenant=X` to drill down |
| `/api/catalog` | scoped to own tenant | all tenants by default; `?tenant=X` to drill down |
| `/api/services` | catalog enrichment scoped to own tenant | (same — admins don't get a special tool here yet) |
| `/api/health{,/:service}` | catalog enrichment scoped to own tenant | (same) |

All four endpoints return a `scopedTo` field — `null` for an admin
viewing all tenants, the tenant string otherwise. The UI uses this
to render a "scope: acme" / "scope: all tenants" hint above the
relevant data block.

## UI surface

- **User badge** (top-right) gains a tag chip when the user's tenant
  is non-default. Tooltip combines IdP issuer (OIDC) + tenant.
- **\<body data-tenant=…>** attribute is set on every identity sync
  so per-tenant CSS theming (brand colour bar, banner) drops in
  without per-tenant builds.
- **Dashboard usage strip** gains a "scope: …" hint and a Tenant
  column when an admin views all tenants unscoped.

## Migration from single-tenant

No migration is required. The smallest opt-in is one user gaining a
`tenant` field:

```diff
 // OMCP_USERS_FILE
 {
   "users": [
-    { "username": "alice", "name": "Alice", "passwordHash": "..." }
+    { "username": "alice", "name": "Alice", "tenant": "acme", "passwordHash": "..." }
   ]
 }
```

Alice's session now writes audit entries tagged `tenant: acme`. Other
users without the field stay in `default`. Pre-E7 audit entries
continue to surface under `?tenant=default`. No data migration step,
no schema change, no replay.

## OIDC integration

```yaml
env:
  OMCP_OIDC_TENANT_CLAIM: "app.tenant_id"   # dotted path; default ""
```

When the claim is absent / empty / non-string in a given session, the
session lands in `default` (least-privilege fallback). Array-valued
claims take the first string entry — multi-tenant per-session
identities aren't supported; an operator wanting per-call switching
should mint distinct tokens.

## MCP credentials

```yaml
env:
  OMCP_API_KEYS: "agent:tok_acme,agent:tok_bigco"
  OMCP_KEY_TENANTS: "agent-acme=acme;agent-bigco=bigco"
  # Note: the credential NAME has to be unique per tenant for the
  # tracker buckets to map cleanly. Use distinct names.
```

Unlisted keys default to `default`. The same OMCP server can serve
multiple tenants over the same `/mcp` endpoint as long as each
credential has a unique name.

## What's not (yet) tenant-scoped

- **Connector configurations** (`config/sources.yaml`) are still
  process-global. A Prometheus instance configured at boot is
  reachable by every tenant. Per-tenant connector pools are a
  follow-up — track via the [tenancy roadmap].
- **Helm chart** doesn't yet split deployments per tenant. The
  documented model is "one Helm release per tenant" if you need full
  network-level isolation; in-process multi-tenancy is for the
  policy / audit / quota / catalog surfaces.
- **OPA policy package** runs process-wide, but the query input
  shape is `{ roles, resource, action, tenant }` — the active
  tenant reaches the Rego evaluator on every decision. Authors can
  write tenant-conditional rules directly, e.g.
  `allow { input.tenant == "acme"; input.action == "read" }`.
  Decisions are cached per `(roles, resource, action, tenant)` so
  cross-tenant verdicts never share a cache slot. If you want full
  package-level isolation (separate Rego bundle per tenant) you can
  still run one OPA instance per tenant; the in-input form is the
  zero-extra-infra path.
- **Per-process self-metrics** (`/metrics`) are not labelled by
  tenant. Anyone scraping the Prometheus endpoint sees aggregate
  counts across every tenant. Operators that need per-tenant
  Prometheus dashboards should currently run one OMCP per tenant
  and let upstream Prometheus do the labelling.
- **MCP credential bucket-key uniqueness** — the rate-limiter and
  token-budget tracker key on `<tenant> <credential-name>`. Two
  credentials sharing a name across tenants get isolated buckets,
  but operators are still advised to use distinct names per tenant
  for log clarity (see the MCP credentials section above).

## See also

- [access-control.md](access-control.md) — RBAC + audit + redaction
  + quotas; the layers tenant-scoping plugs into.
- [auth-oidc.md](auth-oidc.md) — OIDC session bootstrap, claim
  mapping, the `OMCP_OIDC_TENANT_CLAIM` env var.
- [auth-basic.md](auth-basic.md) — local-user file, the `tenant`
  field on user entries.
