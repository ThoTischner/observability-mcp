# Log redaction

`observability-mcp` automatically masks common PII / secret patterns in the
output of the `query_logs` MCP tool **before the payload crosses the MCP
boundary** into the agent's context. This is on by default and protects
operators who haven't already pre-scrubbed their log pipeline.

The redactor runs **only** on MCP tool output, not on the raw responses
from `/api/*` (those go to the operator's own browser session, not a
third-party agent). It's a defence-in-depth complement to source-side
scrubbing — not a substitute for it.

## What gets redacted

| Category | Pattern shape | Replacement |
|---|---|---|
| `email` | `local@domain.tld` (RFC-lite, TLD length 2–24) | `[redacted-email]` |
| `ipv4` | strict 0–255 quads (`192.168.1.42`) | `[redacted-ipv4]` |
| `ipv6` | full or `::`-compressed forms | `[redacted-ipv6]` |
| `bearer` | `Authorization: Bearer <token>` (≥12 char token) | `[redacted-bearer]` |
| `jwt` | `eyJ…header.payload.sig` three-part shape | `[redacted-jwt]` |
| `api-key` | `(api[_-]?key\|x-api-key\|token\|secret)[=:]\s*['"]?<≥16 char value>['"]?` | `[redacted-api-key]` |
| `aws-key` | AWS access key id (`AKIA…` / `ASIA…` / `AROA…` + 16–20 chars) | `[redacted-aws-key]` |
| `slack-token` | `xox[abprsu]-…` Slack tokens | `[redacted-slack-token]` |
| `gh-pat` | `gh[opsuru]_…` and `github_pat_…` GitHub personal access tokens | `[redacted-gh-pat]` |
| `private-key` | PEM-encoded `-----BEGIN [...] PRIVATE KEY-----` blocks (greedy across newlines) | `[redacted-private-key]` |
| `credit-card` | 13–19 digit sequences (with optional `- ` separators) that pass a **Luhn check** so order IDs and timestamps don't get over-redacted | `[redacted-credit-card]` |

The categories are non-overlapping — each redacted region is replaced by
a category-tagged marker that no later pattern matches, so a second pass
over the same payload is a no-op.

## What the agent sees

When at least one match was redacted, the tool result grows a
`_redacted` field with per-category counts:

```json
{
  "logs": [...],
  "_redacted": { "email": 3, "ipv4": 1, "ipv6": 0, "bearer": 0, "jwt": 0, "api-key": 0, "totalMatches": 4 }
}
```

That hint is intentional: the agent can ask the operator for raw access
("4 things were redacted — please share the raw log on a secure channel")
rather than confabulating around scrubbed text.

## Opt-out

### Global

Set `OMCP_REDACTION=off` at server startup to disable redaction
process-wide. Sensible only when:

- Your log pipeline already scrubs PII at ingest.
- The agent runs entirely on-prem with the same trust boundary as the
  raw logs.

### Per-call bypass (preferred)

A tool call can request `bypass_redaction: true` to skip redaction for
that single `query_logs` response. The server honours it **only** when
the calling identity is allowed to bypass — so the per-call arg alone
never weakens redaction. Two ways to grant that:

| Deployment | How to allow the per-call bypass |
|---|---|
| **Credentialed** (`OMCP_API_KEYS` set) | Add the credential's name to `OMCP_KEY_BYPASS_REDACTION` (comma-separated allow-list). |
| **Anonymous** (no credentials) | Set `OMCP_BYPASS_REDACTION_ANON=true`. There is no named credential to allow-list, so this opts the anonymous/stdio identity in. |

This is the right lever for the common single-user, self-hosted case:
an agent investigating its *own* logs needs raw IPs (to geolocate,
dedupe, or separate humans from bots) without the blunt
`OMCP_REDACTION=off` sledgehammer. Redaction stays the default for
every call that does **not** set `bypass_redaction: true`, and every
bypass (engaged or denied) is recorded on the management-plane audit
chain.

Both levers default OFF — redaction is on out of the box.

## False-positive notes

- IPv4 also matches strings that look like dotted version numbers
  (`1.2.3.4`). The redactor errs on the side of over-redaction; that's
  the right default for log payloads.
- The `api-key` pattern requires the value to be at least 16 chars long
  and preceded by a `key=` / `token=` marker — so a free-floating short
  alnum string is left alone.

## Verifying locally

```bash
docker run --rm -w /app -v "$(pwd)/mcp-server:/app" node:20-alpine \
  sh -c "npm i --silent && npx tsx --test src/policy/redact.test.ts"
```

## See also

- [access-control.md](access-control.md) — the runbook for the surrounding
  governance layers (basic-mode auth, RBAC, audit log, rate limits) and
  the investigation playbook entry "Why are my logs returning
  `[redacted-email]`?".
