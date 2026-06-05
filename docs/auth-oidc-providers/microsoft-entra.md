# SSO with Microsoft Entra ID

Wire the gateway against an Entra (formerly Azure AD) tenant. The
gateway uses Entra's OIDC endpoint and treats group object IDs from
the `groups` claim as role keys.

## Register the gateway as an app

1. Entra admin centre → **Applications → App registrations → New
   registration**.
2. Redirect URI: web, `https://<gateway-host>/api/auth/oidc/callback`.
3. After creation, note the **Application (client) ID** and the
   **Directory (tenant) ID**.
4. **Certificates & secrets → New client secret**, copy the value
   (visible only once).
5. **API permissions → Microsoft Graph → Delegated → openid, profile,
   email** (these are added by default for OIDC apps).
6. **Token configuration → Add groups claim** → "Security groups" →
   ID token + Access token; ID = "Group ID".

## Gateway config

```bash
export OMCP_AUTH=oidc
export OMCP_OIDC_PROFILE=microsoft-entra
export OMCP_OIDC_ISSUER=https://login.microsoftonline.com/<directory-id>/v2.0
export OMCP_OIDC_CLIENT_ID=<application-id>
export OMCP_OIDC_CLIENT_SECRET=<client-secret>
export OMCP_OIDC_REDIRECT_URI=https://<gateway-host>/api/auth/oidc/callback
# Map Entra group object IDs to RBAC roles:
export OMCP_OIDC_ROLE_MAP='{"<admin-group-oid>":"admin","<sre-group-oid>":"operator","<read-only-group-oid>":"viewer"}'
```

`OMCP_OIDC_PROFILE=microsoft-entra` preconfigures:

- `scopes = openid profile email`
- `rolesClaim = groups`
- `tenantClaim = tid` — every session is tagged with the Entra
  directory id, so a multi-tenant Entra federation surfaces as
  multi-tenant in the gateway too.

## Helm

```yaml
auth:
  enabled: true
extraEnv:
  - name: OMCP_AUTH
    value: oidc
  - name: OMCP_OIDC_PROFILE
    value: microsoft-entra
  - name: OMCP_OIDC_ISSUER
    value: https://login.microsoftonline.com/<directory-id>/v2.0
  - name: OMCP_OIDC_CLIENT_ID
    value: <application-id>
  - name: OMCP_OIDC_CLIENT_SECRET
    valueFrom:
      secretKeyRef:
        name: oidc-credentials
        key: client-secret
  - name: OMCP_OIDC_REDIRECT_URI
    value: https://<gateway-host>/api/auth/oidc/callback
  - name: OMCP_OIDC_ROLE_MAP
    value: '{"<admin-oid>":"admin","<sre-oid>":"operator"}'
```

## Caveats

- **>200 groups per user** — Entra switches to an `_claim_names`
  graph link instead of inlining group IDs. Use a custom claim
  mapping policy (`https://learn.microsoft.com/azure/active-directory/develop/active-directory-claims-mapping`)
  to surface a curated subset under a different claim, then point
  `OMCP_OIDC_ROLES_CLAIM` at it.
- The default `tenantClaim=tid` puts every Entra directory in its own
  gateway tenant. If you only have one directory, set
  `OMCP_OIDC_TENANT_CLAIM=""` to consolidate everything under
  `default`.
- **Group display names vs object IDs** — the `groups` claim emits
  object IDs by default, not names. Either copy IDs from the Entra
  console into `OMCP_OIDC_ROLE_MAP`, or change the token
  configuration to emit names (less stable across renames).
