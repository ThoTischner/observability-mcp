# RBAC policy engines

OMCP ships with three interchangeable RBAC backends. All three honour
the same `PolicyEngine` interface (`evaluate`, `list`, `roles`,
`kind`) so the UI, the audit chain, and the per-route `need()` gate
work identically regardless of which engine is active.

| Engine | Selected by | Source of truth | Hot reload | Best for |
|---|---|---|---|---|
| **Built-in** | (default) | `mcp-server/src/auth/rbac.ts` `DEFAULT_POLICY` | no — code | demo, single-user, small teams |
| **File** | `OMCP_RBAC_POLICY_FILE=path` | YAML/JSON on disk | no — restart | teams that version-control their policy |
| **OPA** | `OMCP_OPA_URL=http://opa:8181` | Rego in OPA | yes — 5s cache TTL | enterprise / multi-product with central policy |

OPA takes precedence over a file when both are set, unless
`OMCP_POLICY_ENGINE=builtin` opts back into the built-in.

## Built-in (default)

Zero config. The policy is the `DEFAULT_POLICY` map shipped in source.
Visible at `GET /api/policy` (admin-gated) — the engine kind is
`builtin`.

Use when:
- You're running the demo or single-operator setup.
- You don't need to deviate from the viewer / operator / admin / redaction:bypass shape.

## File-backed policy

```bash
OMCP_RBAC_POLICY_FILE=/etc/observability-mcp/policy.yaml
```

File format:

```yaml
roles:
  viewer:
    - { resource: sources, action: read }
    - { resource: services, action: read }
  operator:
    - { resource: sources, action: write }
    - { resource: settings, action: write }
  admin:
    - { resource: users, action: delete }
    - { resource: redaction, action: bypass }
```

Strict validation: unknown resources, unknown actions, AND unexpected
object keys all reject loudly at boot. A typo like `tesource:` doesn't
silently produce an empty grant — the process exits with the typo
identified.

**File-supplied roles REPLACE the built-in** of the same name. A
custom `admin` does **not** inherit `redaction:bypass` from the
built-in; you must re-grant it explicitly if you want it. This is
intentional: an operator deploying a restrictive policy shouldn't
silently inherit broader defaults.

**Fail-closed**: a malformed policy file aborts the boot regardless
of `OMCP_AUTH_ALLOW_FALLBACK`. The alternative — silently reverting
to the broader built-in — would defeat the purpose of a tightening
override.

## OPA engine

```bash
OMCP_OPA_URL=http://opa:8181
OMCP_OPA_PACKAGE=observability/authz   # default
OMCP_OPA_ROLES=admin,operator,viewer    # for the Policy UI catalogue
OMCP_OPA_TOKEN=<bearer>                 # optional, OPA --authentication=token
```

Wire format: OMCP POSTs `/v1/data/${OMCP_OPA_PACKAGE}` with

```json
{ "input": { "roles": ["admin"], "resource": "sources", "action": "delete" } }
```

OPA must reply with either of:

```json
{ "result": true }
```

```json
{ "result": { "allowed": true, "reason": "granted by role admin",
              "permissions": [ { "resource": "sources", "action": "read" } ] } }
```

The rich shape lets the Policy UI render full per-role grant tables
without OMCP needing to know the Rego internals. Plain boolean
responses also work; the UI just shows an empty grant table.

### Boot pre-warm

`PolicyEngine.evaluate()` is synchronous; OPA HTTP is not. The
engine ships a 5s per-(roles, resource, action, tenant) cache. On a
cache miss, `evaluate()` returns a conservative deny + async-fires
a warm. To avoid that "warming-deny" for the very first user
request, OMCP hits every (declared role × valid resource × valid
action × known tenant) combo at boot.

Known tenants = `"default"` plus every value parsed from
`OMCP_KEY_TENANTS`. With 3 roles × 10 resources × 4 actions ×
N tenants, the warm count scales linearly in N; for the typical
case of 1–5 tenants OPA handles it in well under a second.

OIDC tenants only become known at session time, so the very first
request from a brand-new OIDC tenant still pays one warming-deny
per `(role, resource, action)`. Operators that want zero warming-
deny for OIDC-only deployments can list expected tenant names in
`OMCP_KEY_TENANTS` even if no MCP credentials use them — the parser
treats every value as an additional tenant to pre-warm.

The boot log reports:

```
[auth] OPA cache pre-warmed: 372 decisions cached for 3 role(s) × 3 tenants
```

A partial warm (e.g. transient OPA hiccup) logs the count + failure
tally; gates retry on the first user-facing call anyway.

### Try it locally

```bash
make demo-opa
# OPA at  http://localhost:8181
# OMCP at http://localhost:3002 (separate port from the default mcp-server
#                                so you can run both side by side)
```

The example Rego at [`examples/opa/policy.rego`](../examples/opa/policy.rego)
reproduces the built-in DEFAULT_POLICY exactly so you can swap engines
without losing access.

## Redaction-bypass (cross-engine)

The two-gate `redaction:bypass` design (RBAC permission +
`OMCP_KEY_BYPASS_REDACTION` credential allow-list + per-call arg) is
identical across engines. The Rego file just needs to grant the
admin role:

```rego
admin_grants := [..., {"resource": "redaction", "action": "bypass"}]
```

See [`docs/access-control.md`](access-control.md) for the full design.

## Probing the live engine

`GET /api/policy` (admin-gated, `users:delete`) reflects the active
engine and supports a dry-run for ad-hoc verdict probes — useful for
debugging "why doesn't my tenant-conditional Rego rule fire?".

Snapshot:

```bash
curl -s -b "omcp_session=$ADMIN_COOKIE" "$URL/api/policy" | jq '{engine, tenantAware}'
# { "engine": "opa:http://opa:8181", "tenantAware": true }
```

`tenantAware` reflects whether the active engine honours
`session.tenant` on `.evaluate()`. The built-in / file-loaded engines
ignore it (false); OPA threads it into the Rego input (true).

Dry-run a single verdict — tenant defaults to the caller's session
tenant, an explicit `?tenant=` override probes any tenant:

```bash
# As tenant Acme, what does the engine say about sources:delete for the admin role?
curl -s -b "omcp_session=$ADMIN_COOKIE" \
  "$URL/api/policy?roles=admin&resource=sources&action=delete&tenant=acme" | jq .
# { "dryRun": { "roles": ["admin"], "resource": "sources", "action": "delete",
#              "tenant": "acme", "allowed": true, "reason": "allowed by OPA" } }
```

If `tenantAware` is `false` and a Rego rule keyed on `input.tenant`
isn't firing, the engine kind is the diagnostic — switch the gate
plumbing to OPA mode.

## Troubleshooting

### "OPA decision pending (warming cache); request again"

The synchronous gate hit a cache miss. The first user call after a
fresh OPA-mode boot can see this; subsequent calls within 5s use the
warmed result. If it persists, the pre-warm at boot didn't reach OPA
— check the boot log for `[auth] OPA cache pre-warmed:` and the OPA
container's egress + auth.

### "OPA query failed: HTTP 503 from ..."

OPA is down or the wrong URL. The engine caches the denial for ~1s
so OMCP doesn't hammer a flapping OPA, then retries on the next
gate. Once OPA recovers the cache populates naturally; no manual
intervention.

### "RBAC policy loaded from <file> (...)" missing on boot

The file path didn't resolve. Check that `OMCP_RBAC_POLICY_FILE` is
absolute, the volume mount is read-only-ok, and the YAML is valid
(`yq . <file>` to confirm).

### Policy UI shows "Policy view requires the users:delete permission"

You're signed in as a non-admin. The Policy tab is admin-only by
design (it would otherwise reveal the full grant matrix to a viewer).

## See also

- [access-control.md](access-control.md) — RBAC, audit, redaction, quotas.
- [auth-basic.md](auth-basic.md) / [auth-oidc.md](auth-oidc.md) — how
  the role names land in a session in the first place.
