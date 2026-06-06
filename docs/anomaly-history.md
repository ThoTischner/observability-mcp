# Anomaly history (since v2.x / Phase F15)

The gateway's deterministic anomaly detector (MAD + seasonality +
correlator, see [`docs/analysis-engine.md`](analysis-engine.md))
produces scores live. By default those scores live in process memory
only — restart the gateway and the trail is gone. F15 adds an
opt-in **TSDB sink** that mirrors every score to a Prometheus
remote-write endpoint so post-mortem reconstruction can pull "what
did the gateway see at 03:42?" via a normal PromQL query.

## Enable

```bash
export OMCP_ANOMALY_HISTORY_REMOTE_WRITE=https://tsdb.internal/api/v1/write
# Optional auth:
export OMCP_ANOMALY_HISTORY_TOKEN=$BEARER_TOKEN
# Optional extra headers:
export OMCP_ANOMALY_HISTORY_HEADERS="x-scope-org-id=tenant-a,x-extra=foo=bar"
```

In Helm:

```yaml
anomalyHistory:
  enabled: true
  remoteWriteUrl: https://tsdb.internal/api/v1/write
  token: "..."           # or existingSecret: my-tsdb-token
  headers: "x-scope-org-id=tenant-a"
```

## Wire format

One time-series sample per anomaly:

```text
omcp_anomaly_score{
  service="payment",
  tenant="default",
  method="mad",          # mad | seasonality | correlator
  severity="warn",       # info | warn | critical
  signal="request_latency"   # optional
}
```

The sample value is the anomaly score (typically 0..1). Samples
are batched in-process and flushed every 10 seconds; a buffer over
500 entries triggers a synchronous flush. The sink is **best-effort**
— a sick TSDB never blocks the detector and never crashes the
gateway. Failed flushes log once and drop the batch.

## Query it back via `get_anomaly_history`

```text
get_anomaly_history(service="payment", duration="6h", method="mad")
```

The tool runs `omcp_anomaly_score{service="payment",method="mad"}`
over the configured window against any Prometheus source the
gateway already knows about. The operator must wire the
round-trip: point a Prometheus instance at the same TSDB the writer
pushes to, then add that Prometheus as an MCP source.

## Why JSON, not the Prometheus protobuf?

The on-the-wire payload is currently JSON shaped like the Prometheus
`WriteRequest` (labels + samples). A real Snappy-compressed protobuf
client is a follow-up; until it lands, operators using TSDBs that
only accept the protobuf form should front the gateway with a tiny
shim (`prom-aggregation-gateway`, `vmagent`, or a custom 50-line
collector). The JSON path is portable and any new TSDB that accepts
the same shape (Mimir, VictoriaMetrics, Thanos, custom collector)
works without code changes.

## Operational notes

- **Detector hook ships in F15b.** The `AnomalyHistory` writer is
  alive in v2.x and reachable via `get_anomaly_history`; the
  detector-side `record()` hook that fills it from the live
  `detect_anomalies` path lands in the follow-up. Externally-written
  `omcp_anomaly_score` metrics (e.g. from a sibling tool that
  produces them) are already queryable.
- **Retention** is the TSDB's job. The gateway never deletes —
  configure the receiver's retention to match your post-mortem
  window (e.g. 30 days).
- **No live UI sparkline yet** — the Health-tab "score history" view
  is a separate follow-up. Today the data is consumable via the MCP
  tool, the operator's Grafana, or any PromQL client.
