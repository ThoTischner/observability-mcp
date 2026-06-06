# SCIM 2.0 provisioning (since v2.x / Phase F21a)

The gateway speaks a minimal SCIM 2.0 dialect for Users + Groups so
your IdP (Microsoft Entra ID, Okta) can push directory state
directly into the gateway — no manual `OMCP_API_KEYS` rotation, no
per-user `OMCP_USERS_FILE` editing.

## Enable

```bash
export OMCP_SCIM_TOKEN=$(openssl rand -hex 24)   # the bearer the IdP sends
export OMCP_SCIM_STORE=/var/lib/observability-mcp/scim.json   # default /tmp/scim.json
```

Optional — map SCIM groups to gateway RBAC roles for SSO continuity:

```bash
export OMCP_SCIM_GROUP_ROLE_MAP="admins:admin,sre:operator,readers:viewer"
```

The store file is created on first write with `mode 0600`. Atomic
tmp+rename keeps it consistent.

## Endpoints

Mounted at `/scim/v2/`. All endpoints require
`Authorization: Bearer $OMCP_SCIM_TOKEN`.

| Method | Path | Meaning |
|---|---|---|
| GET | `/scim/v2/ServiceProviderConfig` | Discovery — capabilities |
| GET | `/scim/v2/ResourceTypes` | Discovery — supported resource types |
| GET | `/scim/v2/Schemas` | Discovery — schema definitions |
| GET | `/scim/v2/Users` | List users |
| GET | `/scim/v2/Users/:id` | Read user |
| POST | `/scim/v2/Users` | Create user |
| PATCH | `/scim/v2/Users/:id` | Update user (replace-ops only in F21a) |
| DELETE | `/scim/v2/Users/:id` | Deprovision user |
| GET | `/scim/v2/Groups` | List groups |
| GET | `/scim/v2/Groups/:id` | Read group |
| POST | `/scim/v2/Groups` | Create group |
| PATCH | `/scim/v2/Groups/:id` | Update group |
| DELETE | `/scim/v2/Groups/:id` | Delete group |

Every mutating call writes an audit entry tagged
`actor=scim:scim` with the SCIM action name (`User.create`,
`Group.update`, etc.).

## Microsoft Entra ID quickstart

1. Entra admin → **Enterprise applications → your-app → Provisioning**.
2. **Provisioning Mode:** Automatic.
3. **Tenant URL:** `https://<gateway>/scim/v2`
4. **Secret Token:** the value of `$OMCP_SCIM_TOKEN`.
5. **Test connection** → should succeed.
6. **Save**, then under **Mappings** edit the Users mapping so
   `userName` is `userPrincipalName` (or your equivalent).
7. **Provisioning status:** On.

## Okta quickstart

1. Okta admin → your app → **Provisioning → Integration**.
2. **SCIM connector base URL:** `https://<gateway>/scim/v2`.
3. **Unique identifier field for users:** `userName`.
4. **Supported provisioning actions:** Push New Users, Push Profile
   Updates, Push Groups.
5. **Authentication mode:** HTTP Header → header `Authorization`,
   value `Bearer $OMCP_SCIM_TOKEN`.
6. **Test connector configuration** → all checks should pass.

## Scope split — deferred to F21b/c

- Filter / search support (Entra and Okta both support push-only
  without filter; needed if you want Pull provisioning from a
  third-party admin).
- Add / Remove patch ops on members[] / emails[] arrays (F21a
  handles replace-only at the top level — sufficient for typical
  provisioning runs).
- Redis-backed store via the F8 SessionStore for multi-replica
  coherence.
- UI "Provisioning" sub-tab under Access Control showing recent
  SCIM operations + the active group→role map.
- Full SCIM 2.0 compliance test suite.

The shipped surface is enough for the standard Entra + Okta
provisioning checklists to pass.
