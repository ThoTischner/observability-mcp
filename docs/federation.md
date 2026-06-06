# Federation — proxy tools from other MCP gateways (since v2.0 / Phase F10)

The gateway can act as a **client** to other MCP servers, surface
their tools on the local `/mcp` endpoint under a stable namespace
prefix, and forward calls to them. To agents and IDE plugins the
federated tools look identical to the gateway's own — same dispatch
shape, same lifecycle hooks (F7), same audit trail.

This unblocks the common pattern where teams already run multiple
specialised MCP gateways (one per team, one per data domain, one
per legacy adapter) and want a single endpoint for their agents to
talk to.

## Configuring upstreams

!!! note "Env-only configuration today"
    Upstreams are configured exclusively via `OMCP_FEDERATION_UPSTREAMS` —
    there is no `/api/federation` runtime-management endpoint yet
    (planned as a v3.x increment). To change the upstream set, edit
    the env / Helm value and restart the gateway. Tool calls and
    metrics already in flight survive the restart on a sticky-
    ingress / multi-replica deployment.

Set `OMCP_FEDERATION_UPSTREAMS` to a comma-separated list of
`name=url` pairs. Each name must start with a letter and use only
`[a-z0-9_-]`. The URL must end at the upstream's Streamable HTTP
`/mcp` endpoint.

```bash
export OMCP_FEDERATION_UPSTREAMS="payments=https://payments-mcp.internal/mcp,risk=https://risk-mcp.internal/mcp"
export OMCP_FEDERATION_TOKEN_PAYMENTS="bearer-for-payments-gw"
export OMCP_FEDERATION_TOKEN_RISK="bearer-for-risk-gw"
```

Each upstream's static bearer token (forwarded as
`Authorization: Bearer …` on every outbound call) is read from
`OMCP_FEDERATION_TOKEN_<UPPERCASE-NAME>` — separate from the URL list
so tokens never appear in logs or audit entries.

## Tool naming

Every upstream tool is registered locally as
`<upstream-name>.<upstream-tool-name>`. For the config above:

```text
payments.list_open_invoices
payments.charge_card
risk.score_transaction
risk.list_blocked_merchants
```

Clients see these names on `tools/list` exactly as if the gateway
implemented them natively. Per-credential allow-lists, Products, and
RBAC apply to them the same way they apply to native tools — they
flow through `registerTool`, so:

- F1 Product-allow-list gate (`ctx.allowedTools`) decides whether a
  given session even sees them on `tools/list`.
- F7 lifecycle hooks (`tool_pre_invoke`, `tool_post_invoke`) fire
  around every federated call.
- Audit entries record the federated tool with its namespaced name;
  cross-reference with the upstream's own audit log via the timestamp
  + actor.

## Failure mode

- **Initial connect fails** → upstream lands in `degraded`, exposes
  zero tools, the gateway boots normally. A background retry is not
  yet wired (re-deploy to re-connect).
- **Mid-run call fails** → the proxy returns the upstream's
  JSON-RPC error verbatim, the caller sees it as a normal MCP error.
  No retry — let the agent decide.
- **Catalog refresh fails** → previous-known-good catalog stays in
  place, no tool churn. Logged as a warning.

The auto-refresh interval defaults to 5 minutes (the upstream may add
or remove tools between polls). Set `refreshIntervalMs: 0` per-source
to disable (manual refresh only) — exposed via config-yaml integration
in a follow-up; today it's the constant default.

## Capabilities currently shipped

| Feature | Status |
|---|---|
| Streamable HTTP upstream | ✅ |
| Stdio upstream | follow-up |
| WebSocket upstream | follow-up |
| Static bearer auth | ✅ |
| Caller-OIDC passthrough | follow-up (needs per-request identity hand-off) |
| UAID forwarding | follow-up |
| Auto catalog refresh (5min default) | ✅ |
| Manual `/api/federation/<name>/refresh` | follow-up |
| Redis-backed cross-replica catalog cache | follow-up (uses F8 SessionStore once wired) |
| `sources.yaml` shape (vs env vars) | follow-up |
| UI "Add Upstream" modal | follow-up |
| Per-source audit-entry `upstream:` field | follow-up (currently audit logs the namespaced name) |

The follow-ups are tracked under F10b in the sprint plan; nothing in
the current shape is breaking for the deferred items.

## Operational notes

- **Loop prevention** — the gateway does not advertise federation in
  its own `/api/conformance`. An upstream that's itself a federated
  gateway works fine, but be careful with circular topologies (A
  federates B, B federates A) — the tool name namespace prevents
  recursion, but the dispatch latency stacks.
- **Token rotation** — set the new token in
  `OMCP_FEDERATION_TOKEN_<NAME>` and restart the gateway. Hot rotation
  via `/api/federation` is on the follow-up list.
- **Per-tool dispatch latency** = local HTTP round-trip + upstream
  dispatch. Federation typically adds 20-80ms vs a direct call;
  surface this in your client's perceived latency budget.
