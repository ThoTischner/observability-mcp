# Audit sinks — mirror the audit chain to external systems

The management-plane audit log writes a tamper-evident hash-chained
JSONL file (`OMCP_MGMT_AUDIT_FILE`). For compliance workflows that
need the same stream in Splunk, an Elastic SIEM, an OTLP collector
that forwards to a log store, or any HTTP receiver, the gateway also
fans every chained entry out to one or more **sinks**.

> The on-disk JSONL chain is always the authoritative master. Sinks
> are mirrors — they receive entries after they have already been
> chained and persisted locally. A sick receiver never breaks the
> chain or blocks the management plane.

## Built-in sinks

### Webhook (`webhook`)

POSTs each entry as a JSON body to a configured URL.

| Env | Meaning |
|---|---|
| `OMCP_AUDIT_WEBHOOK_URL` | Receiver URL. Setting this enables the sink. |
| `OMCP_AUDIT_WEBHOOK_TOKEN` | Bearer token put on every request (`Authorization: Bearer ...`). |
| `OMCP_AUDIT_WEBHOOK_DLQ` | File path for entries that exhausted retries. Empty = drop after final retry (still logged). |

Retries: 5 attempts total with exponential backoff between attempts
(1s → 2s → 4s → 8s, capped at 30s). Per-attempt request timeout 5s.

Failures that exhaust retries land in the dead-letter file (one JSON
line per entry) so an operator can replay them after the receiver
recovers:

```bash
cat $OMCP_AUDIT_WEBHOOK_DLQ | while read line; do
  curl -sS -X POST -H "content-type: application/json" \
    -H "authorization: Bearer $OMCP_AUDIT_WEBHOOK_TOKEN" \
    --data "$line" "$OMCP_AUDIT_WEBHOOK_URL"
done
```

### Helm chart

```yaml
audit:
  file: /var/lib/observability-mcp/audit.jsonl
  webhook:
    enabled: true
    url: "https://splunk.example.com/services/collector/event"
    # Prefer existingSecret in production:
    existingSecret: "splunk-hec-token"
    deadLetterFile: /var/lib/observability-mcp/audit-dlq.jsonl
```

When `existingSecret` is set, the chart mounts the `token` key from
the referenced Secret into `OMCP_AUDIT_WEBHOOK_TOKEN`. Otherwise the
chart renders a Secret from `audit.webhook.token`.

## Receiver contract

Every POST body is a single chained `AuditEntry`:

```json
{
  "ts": "2026-06-05T20:14:00.000Z",
  "seq": 42,
  "actor": { "sub": "alice", "name": "alice" },
  "tenant": "default",
  "resource": "sources",
  "action": "write",
  "method": "POST",
  "path": "/api/sources",
  "status": 200,
  "ip": "10.0.0.7",
  "prevHash": "...",
  "hash": "..."
}
```

The receiver should:

- Return any 2xx for success.
- Return 4xx for permanent failures (the gateway still retries — the
  client doesn't know the difference between 4xx-typo and 4xx-deliberate).
  Long-term 4xx errors land in the DLQ after the retry budget.
- Be idempotent on `(actor.sub, seq, hash)` — retries can deliver the
  same entry more than once.

## Verifying the chain end-to-end

The DLQ + receiver-side store can be cross-checked against the local
JSONL master:

```bash
# Sequence numbers present in the local master:
jq -r .seq < /var/lib/observability-mcp/audit.jsonl | sort -n > local.seq

# Sequence numbers present in the SIEM (Splunk example):
splunk search 'index=audit | stats values(seq)' > siem.seq

diff local.seq siem.seq
```

Any gap is either an in-flight request (most-recent few entries) or a
sink failure worth investigating.

## Currently-shipped sinks

- ✅ `JsonlFileSink` — the existing on-disk master (always on when a
  file is configured).
- ✅ `WebhookSink` — described above.
- ⏳ `S3CompatibleSink` — hourly rollup to S3 / MinIO. Planned; until
  it lands an operator can wire a webhook receiver that batches and
  uploads.

## Failure mode

If a sink throws synchronously at startup the gateway logs and skips
that sink — it never refuses to boot because a sink misconfigured.
At runtime, a sink that throws for a single entry logs the failure
and continues; the JSONL master always succeeds (or the in-memory
ring fills, depending on configuration).
