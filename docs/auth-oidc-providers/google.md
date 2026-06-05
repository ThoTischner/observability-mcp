# SSO with Google Workspace

## Register the gateway as an app

1. Google Cloud console → **APIs & Services → Credentials → Create
   Credentials → OAuth client ID → Web application**.
2. Authorized redirect URIs:
   `https://<gateway-host>/api/auth/oidc/callback`.
3. Copy the **Client ID** and **Client secret**.

## Gateway config

```bash
export OMCP_AUTH=oidc
export OMCP_OIDC_PROFILE=google
export OMCP_OIDC_ISSUER=https://accounts.google.com
export OMCP_OIDC_CLIENT_ID=<client-id>.apps.googleusercontent.com
export OMCP_OIDC_CLIENT_SECRET=<client-secret>
export OMCP_OIDC_REDIRECT_URI=https://<gateway-host>/api/auth/oidc/callback
```

`OMCP_OIDC_PROFILE=google` preconfigures:

- `scopes = openid profile email`
- `rolesClaim = groups`
- `tenantClaim = hd` — hosted domain. Multi-org Workspace
  deployments get one gateway tenant per Workspace domain
  automatically.

## Group membership

Google's OIDC tokens **do not include group membership by default**.
To surface groups for role mapping, you have two options:

1. **Pre-provision users in the OMCP RoleMap by email address** —
   set `OMCP_OIDC_ROLES_CLAIM=email` and a RoleMap keyed by email:
   ```
   {"alice@example.com":"admin","bob@example.com":"viewer"}
   ```
   Cheap but doesn't scale past a few dozen users.

2. **Wire a custom IdP in front of Google** (Auth0 / Authentik /
   Keycloak federated to Google) that fetches groups from the Google
   Directory API and re-emits them under the `groups` claim. The
   gateway then targets the front IdP instead of Google directly.

## Caveats

- Restrict the OAuth consent screen to your Workspace domain so
  arbitrary @gmail.com users can't even attempt login.
- Google rotates JWKS keys frequently; the gateway re-fetches as
  needed but expect occasional one-request retries on a fresh deploy.
