# Enterprise access-control gate

The MCP server has an **optional** seam that enforces role-based access
control, a product catalog, and an audit log in front of every MCP
tool. It is **off by default** and changes nothing unless an operator
explicitly opts in.

The seam itself (`mcp-server/src/enterprise-gate.ts`) is Apache-2.0 and
ships in the published package. The modules it enforces live under
[`enterprise/`](https://github.com/ThoTischner/observability-mcp/blob/main/enterprise/README.md) and are licensed
`FSL-1.1-Apache-2.0`. Because they sit outside `mcp-server/`, they are
**not** in the npm package or the Docker image — activating the gate
requires running from a full source checkout that still contains
`enterprise/`.

## Modes

The gate is always in exactly one of three modes, reported at
`GET /api/info` under `enterpriseGate`:

| Mode | When | Behaviour |
|---|---|---|
| `off` | No control configured and no entitlement | No-op. Every tool runs exactly as without the gate. The only mode the published artifact can reach. |
| `fail-closed` | A control **is** configured (`OMCP_RBAC_POLICY` or `OMCP_CATALOG`) but the gate cannot activate — missing/invalid/**expired** token, or `enterprise/` absent | **Every tool call is denied.** A broken or expired entitlement never silently disables a control you configured. |
| `active` | A valid entitlement token is present | RBAC + catalog are enforced; each decision is recorded to the audit log; denied calls throw and the tool never runs. |

Only the MCP tool path is gated (it carries the authenticated
principal). The local `/api/*` management UI is unchanged.

## Environment variables

| Variable | Purpose |
|---|---|
| `OMCP_ENTITLEMENT_TOKEN` | The signed token: `<base64url payload>.<base64url sig>` |
| `OMCP_ENTITLEMENT_PUBKEY` | Ed25519 public key — a PEM literal (`\n`-escaped allowed) or `@/path/to/key.pub` |
| `OMCP_RBAC_POLICY` | Path to an RBAC policy JSON (enables RBAC) |
| `OMCP_CATALOG` | Path to a product-catalog JSON (enables the catalog) |
| `OMCP_AUDIT_FILE` | Optional path; appends one JSON line per access decision |

Feature gating: the token's `features` must include `access-control`
for RBAC/catalog enforcement and `audit` for the audit log. A policy
configured without the matching feature is denied (fail-closed).

## Quickstart

**1. Generate an issuer keypair** (OpenSSL — no extra tooling):

```bash
openssl genpkey -algorithm ed25519        -out issuer-ed25519.pem
openssl pkey -in issuer-ed25519.pem -pubout -out issuer-ed25519.pub
```

**2. Mint a token** with the issuer CLI:

```bash
node enterprise/entitlement/mint.mjs \
  --key issuer-ed25519.pem \
  --sub org-acme --tier enterprise \
  --features access-control,audit --ttl 365d
```

It prints the token to stdout. (`--ttl` accepts `<n>s|m|h|d`,
default `365d`.)

**3. Configure the deployment:**

```bash
export OMCP_ENTITLEMENT_TOKEN="$(cat token.txt)"
export OMCP_ENTITLEMENT_PUBKEY="@$(pwd)/issuer-ed25519.pub"
export OMCP_RBAC_POLICY="$(pwd)/enterprise/examples/rbac-policy.json"
export OMCP_CATALOG="$(pwd)/enterprise/examples/catalog.json"
export OMCP_AUDIT_FILE="$(pwd)/audit.jsonl"
```

**4. Verify the mode:**

```bash
curl -s localhost:3000/api/info | jq .enterpriseGate
# { "active": true, "mode": "active" }
```

## Policy and catalog

Working examples live in
[`enterprise/examples/`](https://github.com/ThoTischner/observability-mcp/tree/main/enterprise/examples) and are exercised by
the test suite, so they stay correct:

- [`rbac-policy.json`](https://github.com/ThoTischner/observability-mcp/blob/main/enterprise/examples/rbac-policy.json) — roles
  map principals (the API-key identity, e.g. `key:platform-bot`) to
  allow-lists over `tools` / `sources` / `services`; `"*"` is a
  wildcard, `readOnly` blocks mutating tools, `defaultRoles` applies to
  unbound principals (empty ⇒ default-deny).
- [`catalog.json`](https://github.com/ThoTischner/observability-mcp/blob/main/enterprise/examples/catalog.json) — named
  **products** bundle `sources`/`services`; **grants** map principals to
  products. RBAC answers *which verbs*; the catalog answers *which
  resource bundle*. A request must pass **both**.

The principal id comes from the API-key auth layer (see
[Authentication & TLS](auth-and-tls.md)); with no API key configured the
principal is `anonymous` and, under a default-deny policy, denied.

## Audit log

When `audit` is entitled and `OMCP_AUDIT_FILE` is set, every decision is
appended as a hash-chained JSON line. The chain is tamper-evident:
re-walking it detects any modification, reordering, insertion or
mid-file truncation. Ship the file to your SIEM; treat it as
append-only.

## Security posture

- **Fail-closed.** A configured control with a missing/invalid/expired
  token denies all tool calls — it never degrades to open.
- **No core coupling.** The Apache core never statically imports
  `enterprise/`; the published artifact is a pure no-op.
- **Offline.** Token verification is local Ed25519 — no licensing
  callout, consistent with [offline mode](offline.md).
