# Access control overview

This page is the one-stop guide to the management-plane access controls
shipped over the recent governance series (PRs #229–#235). Each layer
is opt-in — the default deployment is single-user, no auth, exactly like
the README quickstart promises.

**Quick links**

- [The four layers, in dependency order](#the-four-layers-in-dependency-order)
- [Minimal production-ready setup](#minimal-production-ready-setup)
- [Roles & permissions](#roles--permissions)
- [Audit log](#audit-log) — `/api/audit`, hash chain, offline verifier
- [Rate limits](#rate-limits) — `/api/usage`, `X-RateLimit-*` headers
- [Service catalog enrichment](#service-catalog-enrichment)
- [Posture discovery](#posture-discovery) — `/api/info` governance block
- [Behind a reverse proxy](#behind-a-reverse-proxy) — `OMCP_TRUST_PROXY`
- [Investigation runbook](#investigation-runbook)

## The four layers, in dependency order

| Layer | Env knob | Default | Detail doc |
|---|---|---|---|
| **MCP bearer auth** for the agent transport | `OMCP_API_KEYS` | anonymous | [auth-and-tls.md](auth-and-tls.md) |
| **Web UI session login** | `OMCP_AUTH=basic` + `OMCP_USERS_FILE` | anonymous | [auth-basic.md](auth-basic.md) |
| **Role-based permissions** on the management API | (built-in `viewer` / `operator` / `admin`; role assigned via the user file's `roles` field) | only meaningful in basic mode | this doc, "Roles & permissions" |
| **Audit log** of mutating `/api/*` requests | `OMCP_MGMT_AUDIT_FILE` | in-memory ring (500 entries) | this doc, "Audit log" |

Two adjacent controls fall under the same umbrella:

| Control | Env knob | Default | Detail doc |
|---|---|---|---|
| **PII / secret redaction** of `query_logs` output | `OMCP_REDACTION` | `on` | [redaction.md](redaction.md) |
| **Per-identity rate limit** on the `/mcp` transport | `OMCP_TOOL_RATE_PER_MIN` | 60 | (in this doc, "Rate limits") |

## Minimal production-ready setup

This is the smallest configuration that gives a multi-user team a
sensible posture: signed sessions, an audit trail, redaction, and
sliding-window per-identity caps.

```yaml
# values.yaml fragment (Helm) — extraEnv is the chart's pass-through
# slot for ad-hoc env vars; see helm/observability-mcp/values.yaml.
extraEnv:
  - name: OMCP_AUTH
    value: basic
  - name: OMCP_USERS_FILE
    value: /etc/observability-mcp/users.json
  - name: OMCP_SESSION_SECRET
    valueFrom:
      secretKeyRef:
        name: omcp-session
        key: secret
  - name: OMCP_API_KEYS
    valueFrom:
      secretKeyRef:
        name: omcp-mcp-keys
        key: keys
  - name: OMCP_MGMT_AUDIT_FILE
    value: /var/log/omcp/audit.jsonl
  - name: OMCP_TOOL_RATE_PER_MIN
    value: "120"
  # - name: OMCP_REDACTION
  #   value: "on"            # default
  # OMCP_AUTH_ALLOW_FALLBACK is intentionally absent — boot must fail
  # closed if the users file is missing.
```

Mint users with the bundled helper (no host npm install required —
the script uses only node built-ins):

```bash
node scripts/hash-password.mjs alice --name "Alice" --roles operator
node scripts/hash-password.mjs bob   --name "Bob"   --roles viewer
```

Paste both JSON blocks into `users.json`'s `users:` array and mount
the file read-only.

## Roles & permissions

The built-in policy ships three roles. The full table is in
[`mcp-server/src/auth/rbac.ts`](../mcp-server/src/auth/rbac.ts); the
short version:

| | viewer | operator | admin |
|---|:---:|:---:|:---:|
| Read sources / services / health / topology / settings / connectors / audit / catalog | ✅ | ✅ | ✅ |
| Write sources / settings / health-thresholds | – | ✅ | ✅ |
| Write connectors (upload / install) | – | – | ✅ |
| Delete sources / users | – | – | ✅ |

Every mutating `/api/*` route asks `need(resource, action)` before it
runs. A 403 from the gate carries
`{ code: "OMCP_PERMISSION_DENIED", required: {…}, have: […] }` so the
client can render a useful message rather than a generic "forbidden".

The session payload's `roles` field is also surfaced at `GET /api/me`
under `permissions: […]` so the Web UI hides write controls (Add
Source, Save Settings, etc.) the current user can't operate. The
server is still the authoritative gate — UI hiding is purely a UX win.

Admins debugging "why did role X get a 403?" can pull the full active
policy without a source checkout:

```bash
curl -s -b "omcp_session=$ADMIN_COOKIE" "$URL/api/policy" | jq .
# { "policy": { "viewer": [...], "operator": [...], "admin": [...] },
#   "roles": ["viewer", "operator", "admin"], "note": "..." }
```

## Audit log

Every mutating `/api/*` request produces one append-only entry with
actor + resource + action + status + IP + the optional `:name` path
parameter as `target`. Entries are hash-chained: each entry's `hash`
covers the previous entry's `hash`, so
[`scripts/verify-audit.mjs`](../scripts/verify-audit.mjs) can prove
the log hasn't been silently truncated or reordered:

```bash
node scripts/verify-audit.mjs /var/log/omcp/audit.jsonl
# → { "ok": true, "entries": 1234, "tipHash": "…" }   (exit 0)
# or, on a tamper:
# → { "ok": false, "entries": 1234, "brokenAt": 42, "reason": "…" }   (exit 1)
```

The script uses only node built-ins (no `node_modules`) so it works
straight from a source checkout on an air-gapped operator workstation.

For unattended cron monitoring, pass `--quiet` — success produces no
stdout, failure still writes the `{ ok: false, brokenAt, reason }`
JSON. Pair with a non-zero-exit handler in your job runner:

```cron
0 * * * * node /opt/observability-mcp/scripts/verify-audit.mjs --quiet /var/log/omcp/audit.jsonl
```

- File path: `OMCP_MGMT_AUDIT_FILE` (JSONL, append-only). Unset → an
  in-memory ring of the last 500 entries serves the same `GET /api/audit`
  endpoint, useful for the demo / single-user case.
- Read access: `audit:read` permission (granted to viewer / operator
  / admin by default).
- Surface: `GET /api/audit?from=&to=&actor=&action=&limit=` returns the
  most-recent-first slice plus `tipHash`. The Web UI's **Audit Log**
  page renders this alongside the entitlement-gate's MCP-tool audit
  feed.

## Rate limits

The `/mcp` HTTP transport carries one per-identity sliding window:
60 requests/minute per named bearer-token caller by default.
`OMCP_TOOL_RATE_PER_MIN` overrides — accepts any positive integer;
unset / empty / non-numeric / `0` / negative all fall back to the
default 60 (so an operator setting `0` to mean "disable" doesn't
accidentally lock every caller out). The explicit-disable path is
on the roadmap. Anonymous `/mcp` traffic (no `OMCP_API_KEYS`) is
unaffected; the existing IP-level express-rate-limit still applies.

Every `/mcp` response carries the live bucket state in headers so a
well-behaved client can self-pace before hitting the cap:

```http
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 47
X-RateLimit-Window-Ms: 60000
```

A breached cap returns:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 17
Content-Type: application/json
```
```json
{
  "code": "OMCP_IDENTITY_RATE_LIMIT",
  "retryAfterSeconds": 17,
  "limit": 60,
  "windowMs": 60000
}
```

Granularity is per HTTP request, not per JSON-RPC message. A batched
JSON-RPC request counts as one; a multi-tool LLM turn counts as N.

Live snapshot: `GET /api/usage` (gated by `audit:read`) returns the
current windowed count per identity:

```json
{
  "identities": [
    { "actor": "agent-prod", "count": 14, "limit": 60, "windowMs": 60000 },
    { "actor": "ci",         "count":  3, "limit": 60, "windowMs": 60000 }
  ],
  "defaultLimit": 60,
  "windowMs": 60000
}
```

Pass `?actor=<name>` to inspect a single identity (count is 0 for
identities the server has never seen).

## Service catalog enrichment

When `OMCP_SERVICE_CATALOG_FILE` points at a JSON catalog (schema in
[`mcp-server/src/catalog/loader.ts`](../mcp-server/src/catalog/loader.ts)),
every `list_services` / `get_service_health` / `query_metrics` derived
response is decorated with `.catalog = { owner, tier, onCall, slo, … }`.
The agent sees ownership context inline — no separate CMDB hop.

Without the env var the file is missing → empty catalog → enrichment
is a no-op.

## Posture discovery

External dashboards and discovery probes (kube-state-metrics derived
exporters, Helm chart annotations, Backstage plugins, etc.) often want
to learn the deployment's governance shape without holding a session.
`GET /api/info` ships a public `governance` block for exactly that:

```json
{
  "governance": {
    "authMode": "basic",
    "authSecretEphemeral": false,
    "auditPersisted": true,
    "catalogConfigured": true,
    "redaction": true,
    "trustProxy": true,
    "toolRatePerMin": 60
  }
}
```

Booleans + the rate-limit number only — no file paths, no session
secret, no user counts. The expected alert is "this deployment
silently reverted to anonymous mode" or "redaction is off in
prod" — both visible from a single unauthenticated GET.

## Behind a reverse proxy

By default `req.ip` is the raw socket address, so a fronting nginx / Envoy
/ ingress controller makes every audit entry look like `127.0.0.1`. Set
`OMCP_TRUST_PROXY` to one of:

| Value | Meaning |
|---|---|
| `true` | trust every upstream hop (Express default-on shape) |
| `loopback` | trust `127.0.0.1` / `::1` only (sensible same-host nginx default) |
| an integer | trust the last *n* hops |
| comma-separated IPs | explicit list of upstreams to trust |

Unset / `false` keeps the safe default. The same setting also fixes the
`Secure` cookie attribute behind TLS-terminating proxies (the server
detects HTTPS via `req.secure || X-Forwarded-Proto`).

## Investigation runbook

### "Who changed source `payment-prod` yesterday?"

```bash
curl -s "$URL/api/audit?action=write&actor=alice&limit=50" \
  | jq '.entries[] | select(.target == "payment-prod")'
```

### "Why did Claude get 403 just now?"

The client's stderr / log shows the response body. Cross-check the
permission grants for the user:

```bash
curl -s -b "omcp_session=$COOKIE" "$URL/api/me" \
  | jq '.permissions'
```

If the user's role is missing the `resource:action` they tried,
update `OMCP_USERS_FILE` (add the right role to that user's `roles`
array) and have them sign out + back in to refresh the cookie.

### "Why are my logs returning `[redacted-email]`?"

The redactor is on by default. If the source is already PII-clean,
disable it process-wide:

```yaml
env:
  OMCP_REDACTION: "off"
```

There is no per-request bypass today — that's tracked as a follow-up
under the `redaction:bypass` RBAC permission name.

### "Caller hit a 429 on the `/mcp` transport"

The response body identifies the caller's identity bucket. To raise
the cap process-wide:

```yaml
env:
  OMCP_TOOL_RATE_PER_MIN: "240"
```

For a per-role cap, the limiter is structured to accept a per-identity
override map — wiring is on the roadmap.

### "Restart broke my audit chain"

If `OMCP_MGMT_AUDIT_FILE` is set, `AuditLog.bootstrap()` replays the
existing file on start so seq + `tipHash` resume cleanly. If you ever
need to verify the chain manually:

```bash
node -e "
  const { verifyChain } = require('./mcp-server/dist/audit/log.js');
  const lines = require('fs').readFileSync(process.env.AUDIT_FILE, 'utf8').trim().split('\n');
  const entries = lines.map(JSON.parse);
  console.log(verifyChain(entries));
"
```

A break reports `{ ok: false, brokenAt: N, reason: '...' }` and the
script exits non-zero so a cron-driven monitor can alert. Most common
cause is hand-editing the file; restore from backup and replay any
missed changes via the Web UI.
