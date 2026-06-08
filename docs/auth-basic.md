# Management-plane authentication (basic mode)

The observability-mcp server can optionally require a logged-in user before
serving any `/api/*` management endpoint or the Web UI. This is **off by
default** — single-user demos / local development behave exactly as before.

Three modes ship today:

| `OMCP_AUTH` value | Behaviour |
|---|---|
| unset / `anonymous` (default) | Every `/api/*` request is accepted. The UI shows no login screen. |
| `basic` | A signed cookie session is required. Local users live in `OMCP_USERS_FILE`; the UI shows a login modal on first 401. |
| `oidc` | A signed cookie session is required, but the credential exchange goes through an external IdP (Keycloak, Auth0, Authentik, generic OIDC) via PKCE. Same session machinery as `basic`. See [auth-oidc.md](auth-oidc.md). |

> The `/mcp` Streamable HTTP transport keeps using **bearer tokens** through
> the existing `OMCP_API_KEYS` mechanism (see [auth-and-tls.md](auth-and-tls.md)).
> The management-plane auth here is independent — it gates the browser surface,
> not the MCP transport. The two can be combined.

## Quickstart

**1. Mint a user entry.** The bundled helper prompts for a password and emits
a JSON object with a scrypt-hashed password — paste it into the users file.
No `npm install` required; the script uses only node built-ins.

```bash
node scripts/hash-password.mjs alice --name "Alice" --roles operator
# Password for alice: ********
# {
#   "username": "alice",
#   "name": "Alice",
#   "roles": ["operator"],
#   "passwordHash": "scrypt$32768$8$1$<salt>$<hash>"
# }
```

**2. Build the users file** at any path the server can read:

```json
{
  "users": [
    {
      "username": "alice",
      "name": "Alice",
      "roles": ["operator"],
      "passwordHash": "scrypt$32768$8$1$<salt>$<hash>"
    },
    {
      "username": "bob",
      "name": "Bob",
      "roles": ["viewer"],
      "passwordHash": "scrypt$32768$8$1$<salt>$<hash>"
    }
  ]
}
```

**3. Run the server in basic mode:**

```bash
export OMCP_AUTH=basic
export OMCP_USERS_FILE=/etc/observability-mcp/users.json
export OMCP_SESSION_SECRET="$(openssl rand -base64 48)"   # ≥ 32 chars
node mcp-server/dist/index.js
```

Open the Web UI. The first `/api/*` request returns 401, the modal appears,
you sign in with a username from the users file, the cookie is set, and
every subsequent request flows through. A "Signed in as Alice — Sign out"
badge appears in the masthead.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `OMCP_AUTH` | optional | `anonymous` (default) or `basic` |
| `OMCP_USERS_FILE` | basic only | absolute path to a users JSON file (format above) |
| `OMCP_SESSION_SECRET` | recommended | ≥ 32-char symmetric secret used to sign cookies. If unset in basic mode, the server generates one for the process lifetime and logs a warning — sessions will not survive a restart. |
| `OMCP_AUTH_ALLOW_FALLBACK` | optional | When `true` and basic-mode prereqs are missing/invalid, the server falls back to anonymous mode instead of refusing to start. Off by default — production deployments should let the start fail loudly. |
| `OMCP_AUTH_LOCKOUT_MAX_FAILURES` | optional | Failed logins for one account before it locks (default `5`). |
| `OMCP_AUTH_LOCKOUT_WINDOW` | optional | Sliding window in seconds over which failures accumulate (default `900`). |
| `OMCP_AUTH_LOCKOUT_BASE` | optional | First lock duration in seconds; doubles each subsequent lock (default `60`). |
| `OMCP_AUTH_LOCKOUT_MAX` | optional | Cap on a single lock duration in seconds (default `3600`). |
| `OMCP_AUTH_LOCKOUT_DISABLED` | optional | Set truthy to turn the per-account lockout off entirely. |

If `OMCP_USERS_FILE` is missing/unreadable/empty when `OMCP_AUTH=basic`,
the server **refuses to start** (process exit code 1) so a misconfigured
production deployment can never silently serve unauthenticated traffic.
Set `OMCP_AUTH_ALLOW_FALLBACK=true` to opt back into the older
"log-and-degrade-to-anonymous" behaviour — only sensible for throwaway
demos.

### Hot-reload

Editing `OMCP_USERS_FILE` while the server is running takes effect on
the **next login attempt**. Each `POST /api/auth/login` stats the file
and re-reads it when the mtime has changed since the previous attempt
— no server restart needed. The server logs a single `[auth]
OMCP_USERS_FILE changed — reloaded N user(s)` line each time the file
reloads. A transient read error (network FS hiccup) keeps the cached
set so logins continue to work with the last known users.

### Account lockout

Two independent brute-force defences guard `POST /api/auth/login`:

- **Per-IP rate limit** — 20 attempts/min/IP (fixed). Blunts a noisy
  single source.
- **Per-account lockout** — after `OMCP_AUTH_LOCKOUT_MAX_FAILURES`
  failed attempts on one username inside the sliding window, that
  account is temporarily locked regardless of source IP, so a slow or
  distributed grind on a single account is bounded too. Each subsequent
  lock lasts twice as long (`BASE`, `2·BASE`, `4·BASE`, … capped at
  `MAX`). A successful login clears the streak immediately.

A locked login returns `429` with a `Retry-After` header; the response
is identical whether or not the username exists, so it can't be used as
a user-enumeration oracle, and the lock is checked **before** the scrypt
verify so a locked account can't be used to burn CPU. Lock events are
written to the audit log (`actor=<username>`, `status=429`).

State lives in the shared session store — set `OMCP_REDIS_URL` and the
lockout is enforced consistently across replicas (and self-expires via
TTL); without it the lockout is per-process and resets on restart.

A lockout is a temporary, automatic throttle — to permanently disable an
account, remove it from `OMCP_USERS_FILE` (and revoke its live sessions,
see [access-control.md](access-control.md#session-revocation)).

## What's gated, what isn't

In basic mode the cookie is required for every `/api/*` route **except**:

- `GET /api/me` — the UI uses this to discover the current identity
- `POST /api/auth/login`, `POST /api/auth/logout`
- `GET /api/info`, `GET /api/openapi.json` — discovery / OpenAPI doc

Unauthenticated `/healthz` / `/readyz` / `/metrics` stay public so Kubernetes
probes and Prometheus scrapes work without credentials.

The MCP transport (`/mcp`) is untouched and continues to use its own
bearer-token mechanism (or run unauthenticated when no `OMCP_API_KEYS` is
set, exactly as before).

## Cookie semantics

The session cookie (`omcp_session`) is:

- `HttpOnly` — never readable from JavaScript.
- `SameSite=Lax` — protected from cross-site POSTs.
- `Secure` whenever the request was served over HTTPS (the server detects
  TLS via `req.secure` and the `X-Forwarded-Proto` header).
- Signed with HMAC-SHA256 using `OMCP_SESSION_SECRET`. The payload is a
  small JSON blob with the user's `sub`, `name`, optional `roles`, `iat`,
  and `exp` — no server-side store.
- Defaults to a 12-hour lifetime. Rotating `OMCP_SESSION_SECRET` invalidates
  every outstanding session.

## Production checklist

- [ ] `OMCP_SESSION_SECRET` is set to a stable random value (`openssl rand -base64 48`).
- [ ] The users file lives outside the application image and is mounted read-only.
- [ ] The server is fronted by a reverse proxy that terminates TLS, so the
  `Secure` cookie attribute takes effect.
- [ ] User passwords are minted with `scripts/hash-password.mjs` — never
  stored in plaintext, never committed to git.
- [ ] If you also expose `/mcp`, set `OMCP_API_KEYS` so the MCP transport
  isn't anonymous.

## See also

- [access-control.md](access-control.md) — the one-stop runbook covering
  basic-mode auth alongside RBAC, audit log, redaction, rate limits,
  reverse-proxy setup, and the investigation playbook.
- [auth-oidc.md](auth-oidc.md) — the third auth mode, for teams that
  already run an IdP (Keycloak, Authentik, Auth0, Azure AD, ...).
- [tenancy.md](tenancy.md) — the `tenant` field on user entries
  drives multi-tenant scoping of audit, quotas, and the catalog.
