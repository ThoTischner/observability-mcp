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

Set `OMCP_REDACTION=off` at server startup to disable redaction
process-wide. Sensible only when:

- Your log pipeline already scrubs PII at ingest.
- The agent runs entirely on-prem with the same trust boundary as the
  raw logs.

There is no per-request bypass today. A future iteration will introduce
a `redaction:bypass` RBAC permission so an interactive admin session can
flip redaction off for one tool call without restarting the server.

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
