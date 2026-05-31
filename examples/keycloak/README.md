# Demo Keycloak realm

This directory ships a single Keycloak realm export, `omcp-demo-realm.json`,
that drives the `docker-compose --profile auth` demo of OMCP's OIDC mode.

## What's inside

| Username | Password | Group | OMCP role |
|---|---|---|---|
| `admin` | `admin` | `omcp-admin` | `admin` |
| `operator` | `operator` | `omcp-ops` | `operator` |
| `viewer` | `viewer` | `omcp-viewers` | `viewer` |

Mapping happens via `OMCP_OIDC_ROLES_CLAIM=groups` plus
`OMCP_OIDC_ROLE_MAP={"omcp-admin":"admin","omcp-ops":"operator","omcp-viewers":"viewer"}`
(both set in `docker-compose.yml` under the `auth` profile).

**These credentials are DEMO ONLY.** Do not copy this realm to a
production Keycloak — every user has a static, well-known password
and there is no MFA enrolment.

## OIDC client

- Client ID: `observability-mcp`
- Public (PKCE S256, no client secret)
- Redirect URI: `http://localhost:3001/api/auth/oidc/callback`
- Realm: `omcp-demo`
- Issuer URL: `http://localhost:8088/realms/omcp-demo`

## Quickstart

```bash
make demo-oidc        # boots keycloak + mcp-server, waits for /healthz
# Visit http://localhost:3001 — the login modal shows "Sign in with SSO"
```

## Verifying the realm without the demo stack

```bash
# Run keycloak standalone with the realm pre-imported:
docker run --rm -p 8088:8080 \
  -e KEYCLOAK_ADMIN=keycloak -e KEYCLOAK_ADMIN_PASSWORD=keycloak \
  -v "$(pwd)/examples/keycloak/omcp-demo-realm.json:/opt/keycloak/data/import/realm.json:ro" \
  quay.io/keycloak/keycloak:26.3.5 \
  start-dev --import-realm

# In another terminal, hit the discovery doc:
curl http://localhost:8088/realms/omcp-demo/.well-known/openid-configuration | jq .
```
