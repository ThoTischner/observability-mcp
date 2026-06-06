// Anomaly history — persists per-anomaly scores to an external TSDB
// via Prometheus remote-write so post-mortems can replay what the
// gateway saw at a specific time. Opt-in via
// OMCP_ANOMALY_HISTORY_REMOTE_WRITE; default OFF preserves the
// pre-F15 "scores live in process memory only" behaviour.
//
// Wire format: a single time-series sample per recorded anomaly,
// labelled with service / tenant / signal / method (mad / seasonality
// / correlator) / severity. The TSDB-side query then becomes a
// `omcp_anomaly_score{service="payment"}` PromQL.
//
// Buffering: writes are batched on a fixed flush interval so the
// remote-write side never sees a request per anomaly. Failure to
// flush logs once and drops the buffer — the gateway must never
// block on a sick TSDB.

export interface AnomalyRecord {
  /** ISO-8601 timestamp (the moment the score was computed). */
  ts: string;
  service: string;
  tenant: string;
  /** Anomaly score, 0..1 typically. Numeric — the sample written to the TSDB. */
  score: number;
  /** "mad" | "seasonality" | "correlator" — the method that produced the score. */
  method: string;
  /** "info" | "warn" | "critical". */
  severity: string;
  /** Optional source label (which signal the score applied to). */
  signal?: string;
}

export interface AnomalyHistoryConfig {
  /** Remote-write URL. Setting this enables the history sink. */
  url?: string;
  /** Comma-separated key=value pairs for extra request headers. */
  headers?: Record<string, string>;
  /** Bearer token forwarded as Authorization header. */
  bearerToken?: string;
  /** Flush interval in ms. Default 10 000. */
  flushIntervalMs?: number;
  /** Max buffer size before a synchronous flush. Default 500. */
  maxBufferSize?: number;
  /** Per-request timeout (ms). Default 5 000. */
  requestTimeoutMs?: number;
  /** Inject fetch for tests. */
  fetchImpl?: typeof fetch;
}

export function fromEnv(env: NodeJS.ProcessEnv = process.env): AnomalyHistoryConfig {
  const url = env.OMCP_ANOMALY_HISTORY_REMOTE_WRITE?.trim();
  const headers: Record<string, string> = {};
  const raw = env.OMCP_ANOMALY_HISTORY_HEADERS;
  if (raw) {
    for (const part of raw.split(",")) {
      const [k, ...rest] = part.split("=");
      const key = k?.trim();
      const value = rest.join("=").trim();
      if (key && value) headers[key] = value;
    }
  }
  return {
    url: url || undefined,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    bearerToken: env.OMCP_ANOMALY_HISTORY_TOKEN?.trim() || undefined,
  };
}

/**
 * In-process buffer + remote-write client. Use one instance per
 * gateway process; `record()` is called from the anomaly detector;
 * `flush()` runs on the interval AND on SIGTERM.
 */
export class AnomalyHistory {
  private readonly url?: string;
  private readonly headers: Record<string, string>;
  private readonly bearerToken?: string;
  private readonly flushIntervalMs: number;
  private readonly maxBufferSize: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private buffer: AnomalyRecord[] = [];
  private timer?: NodeJS.Timeout;
  private flushing = false;

  constructor(cfg: AnomalyHistoryConfig = {}) {
    this.url = cfg.url;
    this.headers = cfg.headers ?? {};
    this.bearerToken = cfg.bearerToken;
    this.flushIntervalMs = cfg.flushIntervalMs ?? 10_000;
    this.maxBufferSize = cfg.maxBufferSize ?? 500;
    this.requestTimeoutMs = cfg.requestTimeoutMs ?? 5_000;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  /** Whether the history sink is enabled (URL configured). */
  isEnabled(): boolean {
    return Boolean(this.url);
  }

  /** Begin the flush timer. Idempotent. No-op when sink is disabled. */
  start(): void {
    if (!this.isEnabled()) return;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush().catch(() => {
        /* swallow — flush() already logs */
      });
    }, this.flushIntervalMs);
    // unref so the timer doesn't keep the process alive when the
    // main loop is otherwise idle.
    this.timer.unref?.();
  }

  /** Stop the flush timer + flush one last time. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.isEnabled()) await this.flush().catch(() => undefined);
  }

  /** Add one anomaly to the buffer. Silently drops when disabled.
   *  Triggers a synchronous flush if the buffer crosses maxBufferSize. */
  async record(entry: AnomalyRecord): Promise<void> {
    if (!this.isEnabled()) return;
    this.buffer.push(entry);
    if (this.buffer.length >= this.maxBufferSize) {
      await this.flush().catch(() => undefined);
    }
  }

  /** Send the current buffer to the remote-write endpoint. Drops the
   *  buffer on success OR failure — history is best-effort. */
  async flush(): Promise<void> {
    if (!this.isEnabled() || this.buffer.length === 0 || this.flushing) return;
    this.flushing = true;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      await this.sendBatch(batch);
    } catch (err) {
      console.warn(
        "AnomalyHistory: flush dropped %d entries (%s). History is best-effort; check the remote-write endpoint.",
        batch.length,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      this.flushing = false;
    }
  }

  /** Test seam: number of currently-buffered entries. */
  bufferSize(): number {
    return this.buffer.length;
  }

  /** Visible-for-test: format the buffer as a JSON payload mirroring
   *  the Prometheus remote-write metric shape. Real remote-write uses
   *  Snappy-compressed protobuf — we ship JSON here as a portable
   *  baseline that any TSDB-receiving collector can ingest via a tiny
   *  shim. A protobuf+Snappy fast path is a follow-up. */
  formatBatch(batch: AnomalyRecord[]): unknown {
    return {
      // The schema mirrors prometheus.WriteRequest as a JSON object
      // so collectors that already know "labels + samples" can ingest
      // it directly.
      timeseries: batch.map((r) => ({
        labels: {
          __name__: "omcp_anomaly_score",
          service: r.service,
          tenant: r.tenant,
          method: r.method,
          severity: r.severity,
          ...(r.signal ? { signal: r.signal } : {}),
        },
        samples: [{ value: r.score, timestamp: Date.parse(r.ts) }],
      })),
    };
  }

  private async sendBatch(batch: AnomalyRecord[]): Promise<void> {
    if (!this.url) return;
    const body = JSON.stringify(this.formatBatch(batch));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.headers,
    };
    if (this.bearerToken) headers["authorization"] = `Bearer ${this.bearerToken}`;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.requestTimeoutMs).unref?.();
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers,
        body,
        signal: ctl.signal,
      });
      if (!res.ok) {
        const snippet = (await res.text().catch(() => "")).slice(0, 200);
        throw new Error(`remote-write returned ${res.status} ${res.statusText}: ${snippet}`);
      }
    } finally {
      if (typeof t === "object" && t) clearTimeout(t);
    }
  }
}
