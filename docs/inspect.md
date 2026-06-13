# Inspect — observe, learn, and enforce agent behavior

`Inspect` watches the MCP tool calls flowing through the gateway, lets you
**learn a behavior profile** from real traffic, and then **enforce** it — so an
agent (or a stolen credential) that suddenly starts doing something it never did
before is flagged or blocked.

The model is borrowed from **AppArmor's learning workflow** and from
**service-mesh traffic views** (think Kiali for agent tool calls):

```
   OFF  ──▶  OBSERVE  ──▶  DRY-RUN (complain)  ──▶  ENFORCE
              │              │                        │
        record calls   compute what WOULD be     block calls that
        only (zero     blocked, but still allow   fall outside the
        risk)          — review before enforcing   learned profile
```

You are never auto-enforced into a corner: rules are **suggested** from observed
traffic, a human **accepts** them, you watch a **dry-run** prove the profile
against live traffic, and only then do you switch to **enforce**. Exactly the
`complain → aa-genprof → aa-logprof → enforce` loop, applied to tool calls.

## Why

The gateway already has RBAC, a policy engine, redaction, and an audit log —
all of which answer *"is this principal allowed to call this tool at all?"*.
`Inspect` answers a different question: *"is this call **normal** for this
principal, compared to what it has actually been doing?"* That catches the class
of problem RBAC can't — a credential that is legitimately allowed to call
`query_logs`, but is now calling it against namespaces it never touched, at 50×
its usual rate, right after it leaked.

## The three modes

Set the starting mode with `OMCP_INSPECT` (default `observe`); it can also be
changed at runtime from the UI or `PUT /api/inspect/mode`.

| Mode | Records | Evaluates against profile | Blocks | Use it to |
|------|:-------:|:-------------------------:|:------:|-----------|
| `off` | – | – | – | disable entirely |
| `observe` | ✅ | – | – | learn what normal looks like (default, zero risk) |
| `dryrun` | ✅ | ✅ (logs "would block") | – | prove a profile against live traffic before enforcing |
| `enforce` | ✅ | ✅ | ✅ | block calls outside the accepted profile |

`observe` is the default and is **completely read-only** — it adds no decision
to the call path, only a non-blocking recorder. `enforce` is the only mode that
can deny a call, and only ever denies calls that fall outside an **accepted**
rule (suggested-but-unreviewed rules never block anything).

## What gets captured (and what doesn't)

For every tool call the recorder stores a **signature**, never the raw
arguments:

- **identity**: principal id, auth kind, tenant
- **tool**: the tool name (e.g. `query_logs`)
- **resource dimensions**: `source` / `service` / `namespace` — the real values
  (these are the equivalent of AppArmor's file paths)
- **argument shape**: scalar args reduced to coarse buckets (e.g. `enrich_ips`
  batch size → `≤10 / ≤100 / ≤1000`; a query window → `5m / 1h / 1d`); free-text
  queries (PromQL/LogQL) reduced to a structural fingerprint, **not** the literal
  query text
- **outcome**: ok / error, latency
- **decision**: allow / would-block / blocked (in dry-run / enforce)

Arguments are passed through the gateway's existing
[redaction](redaction.md) layer **before** any shape is derived, so secrets and
PII never reach the inspection store. The store keeps shapes, not payloads — by
design, the literal query you ran is never persisted by `Inspect`.

## The profile

A profile is a set of rules. Each rule says *"this subject may call this tool
within these bounds"*:

```yaml
rules:
  - subject: "key:ci-bot"          # principal, or role:/product:/* 
    tool: query_logs
    resources:
      service: [payment-service, order-service]
    args:
      window: ["5m", "1h"]         # learned buckets
    provenance:
      learnedFrom: 412             # observations
      window: "2026-06-01..2026-06-13"
      confidence: 0.98
    status: accepted               # suggested | accepted | rejected
```

Rules are **derived** from the observed window (`POST /api/inspect/profile/derive`),
land as `suggested`, and a reviewer **accepts**, **edits**, or **rejects** each
one. Only `accepted` rules participate in dry-run/enforce. Profiles persist to
`OMCP_INSPECT_PROFILE_FILE` (falls back to an in-memory profile when unset).

A call is a **deviation** when no accepted rule covers it. Deviation kinds:

- `new-tool` — principal called a tool it has no rule for
- `new-resource` — known tool, but a source/service/namespace outside the rule
- `arg-out-of-range` — known tool+resource, but an argument bucket outside the rule
- `new-principal` — an identity with no rules at all

## UI — the `Inspect` tab

Three sub-tabs, consistent with the rest of the console:

1. **Flows** — a live service-mesh-style graph, **Identities → Tools →
   Backends**. Edge thickness is call volume; colour is green / amber / red for
   allowed / deviation / blocked. Click a node or edge to inspect the calls, the
   argument-shape distribution, and to turn an observed edge straight into a
   rule. A time-window selector and a live pause control sit on top, with the
   current mode shown as a chip.
2. **Profile** — the learning workflow: a mode control (Observe → Dry-run →
   Enforce, with a confirmation before enforce), a **"Learn from traffic"**
   button that fills a review queue of suggested rules (accept / edit / reject,
   in bulk), and a table of accepted rules.
3. **Deviations** — every call that fell outside the profile: who, which tool,
   what was unusual, and a one-click *"accept into profile"* or *"confirm
   anomaly"*. In dry-run these are *would-block*; in enforce they are *blocked*.

The current mode is also shown as a chip in the masthead, so the governance
posture is always visible.

## API

All reads require the `inspection:read` permission; mutations require
`inspection:write` and are written to the [audit log](audit-sinks.md).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/inspect/mode` | current mode + counts |
| PUT | `/api/inspect/mode` | set `off`/`observe`/`dryrun`/`enforce` |
| GET | `/api/inspect/flows?window=` | aggregated flow graph (nodes + edges) |
| GET | `/api/inspect/events?from&to&principal&tool&outcome&decision&limit` | raw observation stream |
| GET | `/api/inspect/profile` | accepted + suggested rules |
| POST | `/api/inspect/profile/derive` | derive suggestions from the observed window |
| PATCH | `/api/inspect/profile/rules/:id` | accept / reject / edit a rule |
| GET | `/api/inspect/deviations?window=` | calls outside the profile |

## Configuration

| Env | Default | Meaning |
|-----|---------|---------|
| `OMCP_INSPECT` | `observe` | starting mode: `off` / `observe` / `dryrun` / `enforce` |
| `OMCP_INSPECT_FILE` | _(unset)_ | JSONL path for the observation store; in-memory ring when unset |
| `OMCP_INSPECT_PROFILE_FILE` | _(unset)_ | YAML/JSON path for the persisted profile |
| `OMCP_INSPECT_WINDOW` | `24h` | default learning / flow window |

## Air-gapped & privacy posture

`Inspect` makes **no outbound calls** — it only observes traffic that already
flows through the gateway, so the air-gapped guarantee is unchanged. It stores
argument **shapes**, not payloads, and runs everything through the existing
redaction layer first. The recorder is strictly non-blocking and never throws,
so observation can never slow down or fail a tool call.
