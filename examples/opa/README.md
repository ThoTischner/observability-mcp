# Example OPA wiring for OMCP

The `examples/opa/` directory ships a small Rego policy that mirrors
OMCP's built-in `DEFAULT_POLICY`, plus a Compose profile that lets
you boot the OMCP server in OPA-backed mode in one command.

## Quickstart

```bash
make demo-opa
# OPA:        http://localhost:8181/v1/data/observability/authz
# OMCP (oidc + opa): http://localhost:3002 (no auth in this profile —
#                    the focus is the policy engine; pair with the
#                    auth profile if you want sign-in too.)
```

Visit the **Policies** tab in the UI; the engine badge reads
`opa:http://opa:8181` and the role catalogue mirrors the Rego file's
viewer/operator/admin grants.

The policy file is mounted read-only at `/policy.rego`. Edit it on
the host and restart OPA (`docker compose --profile opa restart opa`)
to reload — there's no hot reload by design; the OMCP cache TTL is
5s so the new verdict is visible within seconds.

## What the policy demonstrates

- **Three roles** (`viewer`, `operator`, `admin`) with the same grant
  shape OMCP ships internally — so an operator can swap engines
  back and forth without losing access.
- **`allowed` rule** — the one OMCP's `OpaPolicyEngine.evaluate`
  queries on every RBAC decision.
- **`permissions` rule** — the optional rich-result shape OMCP
  reads when `input.list = true`, so the Policy UI renders the full
  per-role grant tables without OMCP having to know what's in the
  Rego.
- **`redaction:bypass`** — the special-case admin grant from the
  built-in policy is reproduced verbatim so the per-call
  `bypass_redaction` flag on `query_logs` keeps working.

## Custom policies

Extend `policy.rego` with your own grants, or rewrite from scratch.
The only contracts OMCP imposes are:

1. Reachable at `${OMCP_OPA_URL}/v1/data/${OMCP_OPA_PACKAGE}`.
2. Response shape: either `{result: bool}` or
   `{result: {allowed: bool, reason?: string, permissions?: [{resource, action}]}}`.

If you want to declare a different role catalogue (so the Policy UI
shows the right names), set:

```bash
OMCP_OPA_ROLES=admin,operator,viewer,auditor,bot
```

## See also

- [`docs/policy-engines.md`](../../docs/policy-engines.md) — operator
  runbook covering built-in vs file vs OPA, the two-gate redaction-
  bypass design, troubleshooting.
- [`docs/access-control.md`](../../docs/access-control.md) — the wider
  governance layer.
