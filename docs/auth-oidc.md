# Management-plane authentication — OIDC / SSO mode

OMCP's third auth mode lets an identity provider (Keycloak, Authentik,
Auth0, Okta, Azure AD, Google Workspace, any spec-compliant OIDC IdP)
own the user database. Sign-in becomes a single "Sign in with SSO"
button; the OMCP server only sees identity claims after the IdP has
verified the user.

This page documents the operator-side setup. The two adjacent docs
that frame it:

- [access-control.md](access-control.md) — runbook covering all auth
  modes plus RBAC, audit, redaction, quotas.
- [auth-basic.md](auth-basic.md) — the local-users-file mode.

## Try it locally

The repo ships a one-command Keycloak demo with three pre-provisioned
users so you can verify the round-trip without configuring a real IdP:

```bash
make demo-oidc
# UI:        http://localhost:3001  ("Sign in with SSO")
# Keycloak:  http://localhost:8088  (keycloak / keycloak)
# Users (password = username, DEMO ONLY):
#   admin    → omcp-admin    → role admin
#   operator → omcp-ops      → role operator
#   viewer   → omcp-viewers  → role viewer
```

The realm export lives at
[`examples/keycloak/omcp-demo-realm.json`](../examples/keycloak/omcp-demo-realm.json);
its README documents the client / mappers / groups.

## When to use OIDC mode

- You already run an IdP and want OMCP users + groups to come from
  there (least surprise + central revocation).
- You want SSO with your other internal tools.
- You need short-lived sessions tied to upstream account state — when
  a user is disabled at the IdP, the next OMCP session refresh fails
  closed.

Stick with basic mode when:

- You're running the single-operator demo or a CI fixture.
- You don't have an IdP and don't want to run one.

## Minimum env

```yaml
env:
  OMCP_AUTH: "oidc"
  OMCP_OIDC_ISSUER: "https://idp.example/realms/observability"
  OMCP_OIDC_CLIENT_ID: "observability-mcp"
  OMCP_OIDC_REDIRECT_URI: "https://omcp.example/api/auth/oidc/callback"
  OMCP_SESSION_SECRET: "<32+ chars, openssl rand -base64 48>"
  # Confidential clients also set:
  OMCP_OIDC_CLIENT_SECRET: "<your client secret>"
```

Required:

| Env | Purpose |
|---|---|
| `OMCP_OIDC_ISSUER` | IdP base URL. OMCP appends `/.well-known/openid-configuration` and verifies the doc's own `issuer` field matches (OpenID Connect Discovery 1.0 §4.3). |
| `OMCP_OIDC_CLIENT_ID` | Client identifier registered with the IdP. |
| `OMCP_OIDC_REDIRECT_URI` | Absolute URL pointing at `<your-omcp-host>/api/auth/oidc/callback`. Must match the IdP registration exactly. |

Optional:

| Env | Default | Purpose |
|---|---|---|
| `OMCP_OIDC_CLIENT_SECRET` | (public client) | Set for confidential clients. Sent via HTTP Basic auth on the token endpoint. |
| `OMCP_OIDC_SCOPES` | `openid profile email` | Space-delimited scopes requested at the authorize endpoint. |
| `OMCP_OIDC_ROLES_CLAIM` | `groups` | Dotted path to the claim that holds the user's role-equivalent identifiers. Examples: Keycloak → `realm_access.roles`; Auth0 → `https://your.namespace/roles` (dotted-path doesn't support slashes; use a custom claim mapper instead in that case). |
| `OMCP_OIDC_ROLE_MAP` | `{}` | JSON object mapping claim values to OMCP roles. Unknown values are silently dropped (least privilege). |
| `OMCP_OIDC_LOGOUT_REDIRECT` | `/` | Post-logout landing URL. Point at the IdP's `end_session_endpoint` for IdP-side single sign-out. |
| `OMCP_AUTH_ALLOW_FALLBACK` | `false` | Set to `true` to degrade to anonymous mode on misconfiguration instead of failing closed. Only sensible for throwaway demos. |

## Crypto guarantees

- ID tokens are verified against the IdP's JWKS (refreshed on a 60 s
  cooldown when an unknown `kid` arrives).
- RS256 and ES256 are accepted. `none` and HS256 are rejected.
- Signature → `iss` → `aud` → `exp` → `nbf` → `nonce` are all checked
  on every callback.
- PKCE S256 protects the code exchange. Authorization-code with PKCE
  is the only supported flow; implicit and hybrid are rejected.
- The flow cookie (state + nonce + PKCE verifier + return_to) is
  HMAC-SHA256-signed with the same session secret, lives 5 minutes,
  carries `HttpOnly` + `SameSite=Lax` + `Secure`-by-default.

## Role mapping

Roles attach to OMCP users via two env vars:

```yaml
OMCP_OIDC_ROLES_CLAIM: "groups"   # default; or e.g. "realm_access.roles"
OMCP_OIDC_ROLE_MAP: |
  {
    "omcp-admin":   "admin",
    "omcp-ops":     "operator",
    "omcp-viewers": "viewer"
  }
```

The mapper:

- Walks the dotted claim path (so `realm_access.roles` works out of the
  box for Keycloak).
- Accepts an array or scalar string value.
- Maps each value through `OMCP_OIDC_ROLE_MAP`; **drops** unmapped
  values (least-privilege default).
- Dedupes — a user in both `omcp-admin` and `omcp-ops` groups doesn't
  end up with duplicate `admin` entries in their session.
- Resulting roles drive the existing RBAC engine (`viewer` / `operator`
  / `admin`) unchanged — see [access-control.md](access-control.md).

## IdP-specific setup

### Keycloak

1. Create realm `observability`.
2. New client `observability-mcp`:
   - Client type: OpenID Connect
   - Standard flow only (auth-code)
   - Valid Redirect URIs: `https://omcp.example/api/auth/oidc/callback`
   - Confidential or public — both supported (set `OMCP_OIDC_CLIENT_SECRET` only for confidential).
3. Add groups `omcp-admin`, `omcp-ops`, `omcp-viewers`; assign users.
4. Realm-level "Default Client Scopes" already include `groups` for
   the default `groups` mapper; the claim path stays the default
   (`groups`). For realm-roles-as-roles, set `OMCP_OIDC_ROLES_CLAIM`
   to `realm_access.roles`.

Issuer URL shape: `https://<your-keycloak>/realms/observability`.

### Authentik

1. Create OAuth2/OpenID Provider in Authentik.
2. New Application bound to that provider.
3. Redirect URI: `https://omcp.example/api/auth/oidc/callback`.
4. Default `groups` claim works; map groups via the Property Mapping
   "default-oauth-mapper". Set `OMCP_OIDC_ROLES_CLAIM` to `groups`.

### Auth0

1. Create a Regular Web Application.
2. Allowed Callback URLs: the same redirect URI.
3. Enable Auth0's built-in **Role-Based Access Control** (Application
   → APIs → enable RBAC + "Add Permissions in the Access Token"). This
   emits a plain-top-level `permissions` claim — no namespaced custom
   claim required.
4. Set `OMCP_OIDC_ROLES_CLAIM` to `permissions`.
5. (Optional) Or implement the same via the **Authorization Extension**
   and ensure your post-login Action emits the role names into a
   plain-named claim (Auth0 will silently drop non-namespaced custom
   claims unless you opt into the Authorization Core / RBAC flow that
   bypasses the namespacing requirement). The dotted-path walker
   currently doesn't traverse claim names containing `/`, so
   namespaced custom claims like `https://omcp.example/roles` can't
   be addressed today — file an issue if you need that, or use the
   RBAC `permissions` route above.

### Azure AD / Entra ID

1. App registration → Authentication → Add platform: Web → redirect URI.
2. Add an `appRoles` block to the manifest, assign users.
3. Set `OMCP_OIDC_ROLES_CLAIM` to `roles` (Azure AD emits role names
   under the `roles` claim).

### Generic OIDC

If your IdP publishes a discovery document, you're done — point
`OMCP_OIDC_ISSUER` at the base URL, find the claim that carries
role-equivalent strings, and configure `OMCP_OIDC_ROLES_CLAIM` +
`OMCP_OIDC_ROLE_MAP` accordingly.

## Verifying posture

```bash
curl -s "$URL/api/info" | jq '.governance | { authMode, oidcIssuer, redaction, auditPersisted }'
# {
#   "authMode": "oidc",
#   "oidcIssuer": "https://idp.example/realms/observability",
#   "redaction": true,
#   "auditPersisted": true
# }
```

`make doctor` surfaces the same single-line summary.

## Investigation runbook

### "Why am I redirected straight back to /login without an error?"

The flow cookie expired (5 min default) or the browser dropped it
between `/login` and `/callback`. Cookie expiry is intentional — re-
clicking "Sign in with SSO" gets you a fresh flow.

### "I see `oidc_idp_error access_denied`"

The IdP refused to issue a token — typically the user cancelled
consent or isn't allowed to access the OMCP application. Check the
IdP-side audit log; the OMCP audit log records only the truncated
error code.

### "I see `oidc_token_exchange_failed`"

The token exchange round-trip failed. Likely causes:
- `OMCP_OIDC_CLIENT_SECRET` wrong / unset for a confidential client.
- `OMCP_OIDC_REDIRECT_URI` doesn't exactly match the IdP-side
  registration (trailing slash counts).
- The IdP rate-limited the token endpoint.

### "I'm logged in but `/api/me` shows `roles: []`"

The roles-claim path is right but no group maps. Check the raw claim
set via the IdP's "test token" feature, confirm `OMCP_OIDC_ROLES_CLAIM`
points at the right field, and that `OMCP_OIDC_ROLE_MAP` has entries
for the values that actually appear.

### "Sign-in worked but pages still 401"

The session cookie was set on the OIDC callback but isn't sent back
on subsequent `/api/*` requests. Usually a `Secure` / cross-origin
issue: ensure the OMCP redirect URI and the UI URL share an origin
(or you're behind a reverse proxy with `OMCP_TRUST_PROXY` set).

## See also

- [access-control.md](access-control.md) — RBAC, audit log, rate
  limits, redaction.
- [auth-basic.md](auth-basic.md) — local-users-file alternative.
- [auth-and-tls.md](auth-and-tls.md) — TLS termination + the `/mcp`
  bearer-token gate.
