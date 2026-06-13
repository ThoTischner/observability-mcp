# SCIM 2.0 provisioning (since v2.x / Phase F21a)

The gateway speaks a minimal SCIM 2.0 dialect for Users + Groups so
your IdP (Microsoft Entra ID, Okta) can push directory state
directly into the gateway — no manual `OMCP_API_KEYS` rotation, no
per-user `OMCP_USERS_FILE` editing.

> **SCIM provisioning is an entitled control.** It is OFF by default
> (no `OMCP_SCIM_TOKEN`), so the open-source surface is unchanged — local
> `OMCP_USERS_FILE` and `OMCP_API_KEYS` auth stay free. Pushing directory
> state from an IdP over SCIM requires the `scim` entitlement; with
> `OMCP_SCIM_TOKEN` set but no valid entitlement the gateway keeps running
> but **refuses to mount `/scim/v2/*` (fail-closed)** and logs the reason.
> See [enterprise-gate.md](enterprise-gate.md).

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

## Helm install (since Phase P5)

The chart ships a first-class `scim:` value block — no `extraEnv`
contortions needed:

```yaml
scim:
  enabled: true
  storePath: /var/lib/observability-mcp/scim.json
  token: <bearer the IdP sends>          # OR reference existingSecret instead
  existingSecret: ""                     # name of a Secret with key `token`
  groupRoleMap: "admins:admin,sre:operator,readers:viewer"
```

A matching Secret template renders when `enabled=true` AND `token`
is set AND `existingSecret` is empty — pick `existingSecret` over
inline `token` for production so the value never enters the rendered
manifest. Mount a PVC at `storePath` if you want provisioned state
to survive pod restarts.

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

## Multi-replica

Default backend is the on-disk JSON file. For a multi-replica
deployment the file is per-pod and a SCIM push delivered to
replica A is invisible to replica B. Switch the backend to
Redis so all replicas read/write the same snapshot:

```yaml
scim:
  enabled: true
  backend: redis              # default: file
  redisUrl: redis://omcp-redis:6379/0
  # or, recommended for prod:
  # redisExistingSecret: omcp-scim-redis     # secret with key `url`
  redisKey: "omcp:scim:snapshot"
```

`redisExistingSecret` lets you keep the connection string out of
the values file — supply a Secret with a single key `url`. The
chart wires it through to the pod as `OMCP_SCIM_REDIS_URL`.

Concurrency note. SCIM clients (Entra, Okta, JumpCloud, generic
SCIM) deliver provisioning requests SERIALLY per resource — the
upstream IDP holds the connection open until the gateway responds.
A single load-balanced gateway in front of N replicas observes
one in-flight request per resource at a time, so the
single-key snapshot model matches SCIM's source-of-truth
semantics. Within a replica, persists are serialised so two
concurrent route handlers can't race each other to the write.

## PATCH operations

The `PATCH /scim/v2/{Users,Groups}/:id` endpoint supports the
RFC 7644 §3.5.2 PatchOp forms the major IdPs emit:

| op | path | effect |
|---|---|---|
| `replace` | _(none)_ | merge the allow-listed attributes in `value` |
| `replace` | `displayName` | set that attribute |
| `add` | _(none)_ | merge `value`; array attrs append (deduped), scalars set |
| `add` | `members` | append member(s) to the group (deduped by `value`) |
| `remove` | `members[value eq "<id>"]` | drop the matching member |
| `remove` | `members` | clear the whole array |

`members` and `emails` are the multi-valued attributes that honour
element add/remove + the `[sub eq "x"]` filter segment. Chained ops
in one request compose against the running value (Entra sends an
`add` + a filtered `remove` in a single PatchOp body). Every
attribute name written is gated through an allow-list, and filter
sub-attributes are read-only, so a crafted path can't reach
`__proto__` / `constructor` (a path that names a non-allow-listed
attribute is skipped fail-closed).

## Compliance suite

`mcp-server/src/scim/compliance.test.ts` is an end-to-end harness
that exercises the live `/scim/v2` surface against RFC 7643/7644:
discovery (ServiceProviderConfig / ResourceTypes / Schemas), the
401 auth gate, the User + Group lifecycle (create → read → list →
patch → delete), `409 uniqueness`, `404` with the SCIM error
schema, and the Q14 membership add/remove-by-filter ops. It is
self-cleaning (every resource it creates is deleted at the end).

It is env-gated like the MCP conformance suite — unset means every
test skips, so it's inert in a plain unit run:

```bash
# against a SCIM-enabled gateway
make scim-compliance
# or directly:
OMCP_SCIM_COMPLIANCE_URL=http://localhost:3000/scim/v2 \
OMCP_SCIM_COMPLIANCE_TOKEN=$OMCP_SCIM_TOKEN \
  npx tsx --test src/scim/compliance.test.ts
```

> Note: SCIM clients send `Content-Type: application/scim+json`
> (RFC 7644 §3.1). The gateway's JSON body parser accepts both
> `application/json` and any `application/*+json` media type, so
> Entra / Okta requests parse correctly.

## Scope split — deferred to v3.x

- Filter / search support on the collection endpoints (Entra and
  Okta both support push-only without filter; needed if you want
  Pull provisioning from a third-party admin).
- `replace` of a single member's sub-attribute via a filtered path
  (`members[value eq "x"].display`) — rare; the IdPs remove + re-add
  instead.
- UI "Provisioning" sub-tab under Access Control showing recent
  SCIM operations + the active group→role map.

The shipped surface is enough for the standard Entra + Okta
provisioning checklists to pass.
