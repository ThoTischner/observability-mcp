# SSO with Okta

## Register the gateway as an app

1. Okta admin → **Applications → Create App Integration → OIDC →
   Web Application**.
2. Sign-in redirect URI:
   `https://<gateway-host>/api/auth/oidc/callback`.
3. After save, copy **Client ID** and **Client secret**.
4. **Sign On → Groups claim filter**: add `groups` matching whatever
   regex covers the groups you want emitted (`.*` for all).
5. **Authorization Server** (default or custom): note the issuer URL
   under **Settings → Issuer URI**.

## Gateway config

```bash
export OMCP_AUTH=oidc
export OMCP_OIDC_PROFILE=okta
export OMCP_OIDC_ISSUER=https://<your-org>.okta.com/oauth2/default
export OMCP_OIDC_CLIENT_ID=<client-id>
export OMCP_OIDC_CLIENT_SECRET=<client-secret>
export OMCP_OIDC_REDIRECT_URI=https://<gateway-host>/api/auth/oidc/callback
export OMCP_OIDC_ROLE_MAP='{"sre-admins":"admin","sre-on-call":"operator","sre-readers":"viewer"}'
```

`OMCP_OIDC_PROFILE=okta` preconfigures:

- `scopes = openid profile email groups` (Okta requires the `groups`
  scope or the claim is omitted)
- `rolesClaim = groups`

## Caveats

- **Authorization Server choice**: the `default` AS works for most
  setups. Custom AS lets you scope tokens; the issuer URL pattern
  becomes `.../oauth2/<auth-server-id>`.
- **Group names vs IDs** — Okta emits names by default, which is
  human-friendly but renaming a group breaks role mapping. Decide
  early which is your source of truth and document it next to the
  RoleMap config.
- **Custom claim mapping** — if your groups live under a non-default
  claim, set `OMCP_OIDC_ROLES_CLAIM=<your-claim>` to override the
  profile default.
