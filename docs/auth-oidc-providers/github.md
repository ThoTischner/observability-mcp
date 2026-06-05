# SSO with GitHub

GitHub's classic OAuth doesn't expose groups, and its **OIDC for
GitHub Apps** is the only path that returns OIDC-shaped tokens. The
gateway treats team membership as the role source.

## Register the gateway as a GitHub App

1. GitHub → **Settings → Developer settings → GitHub Apps → New
   GitHub App**.
2. Callback URL:
   `https://<gateway-host>/api/auth/oidc/callback`.
3. Request user permissions: **email (read)**, **org members (read)**.
4. Generate a client secret, install the app on your organisation.

## Gateway config

```bash
export OMCP_AUTH=oidc
export OMCP_OIDC_PROFILE=github
export OMCP_OIDC_ISSUER=https://token.actions.githubusercontent.com
export OMCP_OIDC_CLIENT_ID=<client-id>
export OMCP_OIDC_CLIENT_SECRET=<client-secret>
export OMCP_OIDC_REDIRECT_URI=https://<gateway-host>/api/auth/oidc/callback
export OMCP_OIDC_ROLE_MAP='{"my-org/sre-admins":"admin","my-org/oncall":"operator","my-org/readonly":"viewer"}'
```

`OMCP_OIDC_PROFILE=github` preconfigures:

- `scopes = openid profile email read:org`
- `rolesClaim = groups`

## Surfacing teams as the `groups` claim

GitHub does **not** put teams into a `groups` claim out of the box.
Two production-friendly patterns:

1. **Front with a Keycloak / Authentik instance** that federates to
   GitHub and pulls org/team membership via the GitHub REST API,
   re-emitting it under a `groups` claim. The gateway then points at
   the front IdP rather than GitHub directly.
2. **Custom claim provider** if you self-host GitHub Enterprise — the
   admin can mint a custom OIDC claim provider that emits team
   names. See the GitHub Enterprise admin docs for the current
   procedure.

For demo / small-team use, set `OMCP_OIDC_ROLES_CLAIM=login` and
key the RoleMap on GitHub usernames:

```
{"alice":"admin","bob":"viewer"}
```

## Caveats

- GitHub OIDC is intended for GitHub Actions workloads first;
  human SSO is a secondary use case. Expect to maintain the
  federated IdP path for any non-trivial deployment.
- Per-user email visibility depends on the user's GitHub profile
  setting. Some users have email private — fall back to `login` as
  the principal subject if email is missing.
