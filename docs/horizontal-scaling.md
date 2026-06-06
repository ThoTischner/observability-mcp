# Horizontal scaling (since v2.0)

The gateway holds short-lived state — MCP Streamable HTTP session
metadata, OIDC flow state (PKCE verifier + nonce + return target),
DCR-registered client metadata, and (with Phase F10) federation
catalogue cache. Until v2.0 all of this lived in process memory, so
running more than one replica required sticky-session ingress and
risked silently losing state on pod rolls.

v2.0 introduces an external **session store** the gateway can point
at — today an in-memory map (the default, preserves the pre-F8
behaviour) or a Redis-backed store for true multi-replica HA.

## When you need it

| Deployment shape | Configuration |
|---|---|
| Single replica, demo / dev | Defaults. Nothing to do. |
| Single replica, prod | Defaults. Pod recreated on rolling release → momentary downtime expected. |
| Multi-replica, prod | **Enable the Redis store.** Otherwise OIDC callbacks land on a replica that doesn't know about the flow state, and Streamable HTTP sessions stick to whichever pod served them. |

## Enable the Redis store

### Env (when running standalone)

```bash
export OMCP_REDIS_URL=redis://redis.observability.svc.cluster.local:6379
export OMCP_REDIS_KEY_PREFIX=omcp:   # optional; default omcp:
```

### Helm

The chart does not ship a Redis subchart by design (operators usually
have their own managed Redis or in-cluster instance). Set the URL on
your existing Redis:

```yaml
replicaCount: 3
strategy:
  type: RollingUpdate
redis:
  enabled: true
  url: "redis://redis.shared.svc.cluster.local:6379"
  keyPrefix: "omcp-prod:"
```

`replicaCount: 3` + `RollingUpdate` give continuous availability; the
chart automatically renders a `PodDisruptionBudget` with
`minAvailable: 1` (override via `podDisruptionBudget.minAvailable`)
whenever `replicaCount > 1`.

## Without the shared store

If you cannot run Redis yet but still need >1 replica (e.g. for
horizontal request throughput on stateless `/api/*` paths), enable
**sticky-session ingress** so each session lands consistently on the
same pod:

```yaml
replicaCount: 3
ingressSticky:
  enabled: true
```

This renders nginx-ingress annotations
(`affinity: cookie`, `session-cookie-name: omcp-affinity`). Other
ingress controllers need an equivalent override via
`ingress.annotations`.

This is a fallback — OIDC login attempts can still fail when the
callback hits a different pod than the login start. The Redis store
is the production answer.

## Failure modes

- **Redis unreachable at boot** → the gateway logs a warning and
  falls back to in-memory. It boots. Multi-replica deployments lose
  cross-replica coherence until Redis returns; restart the pod to
  pick up the live store once Redis is healthy.
- **Redis flaps mid-run** → each `get`/`set` returns the driver's
  error, which the calling subsystem (OIDC / DCR / federation)
  handles by treating the entry as missing and re-issuing the
  underlying request. No crash.
- **Replicas with different `OMCP_REDIS_KEY_PREFIX`** → each replica
  effectively reads its own keyspace. Tie the prefix to the Helm
  release name so this can't drift.

## Capacity guidance

- **Key count**: O(active sessions + active OIDC flows + DCR
  registrations + federation cache). Production realistic upper
  bound: ~10k. A 1 GB Redis is way over-provisioned; share with
  whatever other tooling is in the cluster.
- **TTLs**: OIDC flow state writes with a 10-minute TTL (matching
  the spec's `acceptable clock skew + login latency` window). MCP
  Streamable HTTP sessions use no TTL (Streamable HTTP itself owns
  liveness via the session-id header). DCR registrations are
  permanent (deleted explicitly on revoke).

## Transport session map (Q11 / v3.1)

Until v3.1, the MCP Streamable HTTP sessions held in a process-local
`Map<sessionId, Transport>` were the *only* per-session state — no
cross-replica visibility. With `replicaCount > 1` and no sticky
ingress, a request for sessionId `S` minted on replica A could land
on replica B; B silently created a new transport and the client
ended up alternating between two transports for the same logical
session.

v3.1 promotes the per-session metadata (owner-replica id +
last-active + virtual-server product slug) onto the same
`SessionStore` backend the OIDC + DCR state already uses
(`mcp-server/src/transport/transportSessionMap.ts`). Pick:

- `InMemoryTransportSessionMap` — identical to pre-v3.1 behaviour,
  used when no Redis is configured.
- `SessionStoreBackedTransportSessionMap` — wraps the existing
  `RedisSessionStore`, every replica writes its own session
  metadata to the shared store. A replica that receives a request
  for a locally-unknown sessionId consults the shared map and
  refuses with `410 Gone` if the session was minted elsewhere;
  the client retries and load-balancer rehashing eventually finds
  the owner.

Transport objects themselves stay local — they hold open HTTP
response handles and aren't serialisable. The TTL on each metadata
entry (default 30 minutes matching `SESSION_TTL_MS`) reaps stale
entries when a replica disappears without graceful shutdown.

With this in place sticky ingress is a **performance optimisation**,
not a correctness requirement.

## Migration from in-memory single replica

Single-replica deployments without `OMCP_REDIS_URL` continue working
identically — F8 changes nothing for them. A best-effort serialize on
SIGTERM (write open sessions to `OMCP_STATE_DIR/sessions.json`,
re-read on boot) is on the roadmap so a single-replica rolling
restart doesn't drop in-flight sessions; until it lands, plan for the
brief window of session loss that a single-replica `Recreate`
strategy implies.
