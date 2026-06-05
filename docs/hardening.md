# Hardening (since v2.0 / Phase F11)

The gateway's management plane (`/api/*`) and the SPA hosting it ship
with a baseline of web-app hardening:

- CSRF protection on every mutating `/api/*` request
- SSRF strict-mode on operator-supplied connector URLs

JWT revocation, account lockout for local accounts, configurable
password policy, and CSP nonces with a `report-to` channel are split
out to follow-up (F11b) — the present surface closes the highest-risk
gap (browser-driven CSRF) and the SSRF cloud-metadata vector.

## CSRF

Pattern: **double-submit cookie**. On any authenticated page render
the gateway issues an `omcp-csrf` cookie whose value is 32 random
bytes (base64url). The SPA reads it (the cookie is **not** HttpOnly —
that's the whole point) and echoes it in `X-CSRF-Token` on every
mutating request. The server compares the header against the cookie
in constant time and rejects mismatches with `403 csrf_token_mismatch`.

```text
POST /api/sources
  Cookie: omcp-csrf=tok123
  X-CSRF-Token: tok123     ← must equal the cookie value
```

### Bypass for bearer-token clients

`Authorization: Bearer …` and `X-API-Key:` requests skip CSRF
validation by default (`OMCP_CSRF_BYPASS_BEARER=true`, on). The
threat model justifies this: a third-party site cannot set arbitrary
`Authorization` headers in a browser CORS request, so there's no
confused-deputy scenario with a static API token. CI / agents / MCP
clients keep working unchanged.

To force CSRF on every mutating call regardless of auth method, set
`OMCP_CSRF_BYPASS_BEARER=false`. This is overkill for most
deployments; useful only if you embed the SPA in a context where
both cookie sessions AND bearer tokens are presented from a browser.

### Safe methods

`GET`, `HEAD`, `OPTIONS` skip the enforcer — these are nominally
read-only by HTTP convention. Any route that mutates state on a `GET`
is a separate bug; the gateway has none.

## SSRF strict-mode

Operator-typed URLs (connector backends in `/api/sources`, the
test-connection probe, federation upstreams) flow through a guard
that rejects:

- Non-`http(s)` schemes (`file:`, `ftp:`, …)
- IPv4 cloud-metadata IP `169.254.169.254` (shared by AWS / GCE /
  Azure / Oracle) and the AWS IMDS IPv6 address (`fd00:ec2::254`),
  regardless of any opt-out
- Private IPv4 ranges (`10.*`, `172.16-31.*`, `192.168.*`,
  `127.*`, `169.254.*`, `0.*`)
- Private/loopback/link-local/unique-local IPv6 (`::1`,
  `fc00::/7`, `fe80::/10`)

The `metadata.google.internal` hostname is also rejected (DNS-name
shortcut to the GCE metadata endpoint).

### Allowing in-cluster backends

In-cluster Prometheus / Loki / Tempo at e.g. `10.0.0.5:9090` is a
common, legitimate target. Set `OMCP_ALLOW_PRIVATE_BACKENDS=true` to
disable the private-IP rejection. Cloud-metadata IPs stay blocked
even with the opt-out — there's no legitimate operational case for
the gateway to hit them.

### DNS resolution limitation

The current guard is **hostname-only** — it doesn't resolve DNS. A
hostname pointing at a private IP slips through. Concrete impact:
typed URLs like `http://10.0.0.1` get blocked, but
`http://prom.internal` does not (because we don't resolve
`prom.internal`). The DNS-resolved guard is on the F11b list; until
it lands, treat the guard as a typo-and-typed-mistake fence and
combine with a network-policy egress restriction (the Helm chart's
default `networkPolicy` template already restricts egress to the
namespace) for defense in depth.

## Environment reference

| Env | Default | Meaning |
|---|---|---|
| `OMCP_CSRF_BYPASS_BEARER` | `true` | Skip CSRF for bearer-token / X-API-Key clients. Set `false` to enforce CSRF on every mutating /api/* call. |
| `OMCP_ALLOW_PRIVATE_BACKENDS` | unset | Set `true` to allow private-IP connector URLs (in-cluster Prometheus etc.). Cloud-metadata IPs stay blocked regardless. |

## Verification

- `make conformance` and `make smoke` exercise both behaviours end-to-end against the demo stack.
- Curl probe to confirm CSRF is on:
  ```bash
  curl -i -X POST http://localhost:3000/api/sources \
    -H 'content-type: application/json' --data '{}'
  # → HTTP/1.1 403 Forbidden { "error": "csrf_token_mismatch", ... }
  ```
- Curl probe to confirm SSRF guard:
  ```bash
  # With strict default, this is rejected by validateSourceUrl:
  curl -X POST http://localhost:3000/api/sources \
    -H 'Authorization: Bearer …' -H 'content-type: application/json' \
    --data '{"name":"probe","type":"prometheus","url":"http://169.254.169.254/"}'
  # → 400 with "cloud-metadata IP ... is rejected"
  ```
