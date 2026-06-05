// WebhookSink: POST every audit entry to an HTTP endpoint (Splunk
// HEC, generic SIEM ingestor, or any service that accepts a JSON
// body). Retries with exponential backoff; entries that exhaust their
// retries land in a dead-letter file on disk so an operator can
// replay them once the receiver recovers.
//
// The sink runs entirely in-process — no queue daemon, no broker, no
// extra runtime dep. Suitable for the OSS single-binary deployment.

import { appendFile } from "node:fs/promises";
import type { AuditEntry } from "../log.js";
import type { AuditSink } from "./types.js";

export interface WebhookSinkOptions {
  /** Receiver URL. Required. */
  url: string;
  /** Optional bearer token mounted into the Authorization header. */
  token?: string;
  /** Additional headers to merge into every request. */
  headers?: Record<string, string>;
  /** Initial backoff before the first retry (ms). Default 1_000. */
  initialBackoffMs?: number;
  /** Cap on individual-retry sleep (ms). Default 30_000. */
  maxBackoffMs?: number;
  /** Total attempts (including the first). Default 5. */
  maxAttempts?: number;
  /** Path to write entries that exhausted retries. Optional. */
  deadLetterFile?: string;
  /** Inject a fetch impl for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Inject a sleep impl for tests; defaults to setTimeout-based. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Per-attempt request timeout (ms). Default 5_000. */
  requestTimeoutMs?: number;
}

export class WebhookSink implements AuditSink {
  readonly name = "webhook";
  private readonly url: string;
  private readonly token?: string;
  private readonly headers: Record<string, string>;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxAttempts: number;
  private readonly deadLetterFile?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly requestTimeoutMs: number;
  /** Outbound writes are queued so retries on one entry don't reorder
   * later entries arriving in parallel. */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(opts: WebhookSinkOptions) {
    if (!opts.url) throw new Error("WebhookSink: url is required");
    this.url = opts.url;
    this.token = opts.token;
    this.headers = opts.headers ?? {};
    this.initialBackoffMs = opts.initialBackoffMs ?? 1_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.deadLetterFile = opts.deadLetterFile;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl =
      opts.sleepImpl ??
      ((ms: number) => new Promise((r) => setTimeout(r, ms).unref()));
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5_000;
  }

  async write(entry: AuditEntry): Promise<void> {
    this.writeQueue = this.writeQueue.then(() =>
      this.attemptWithRetries(entry).catch((err) => {
        // Final exhaustion path already wrote to DLQ if configured;
        // log here so the operator sees the symptom even without DLQ.
        console.warn(
          "WebhookSink: dropping entry seq=%d after %d attempts: %s",
          entry.seq,
          this.maxAttempts,
          err instanceof Error ? err.message : String(err),
        );
      }),
    );
    // Returning before the request completes keeps record() latency
    // independent of webhook receiver health.
    return Promise.resolve();
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private async attemptWithRetries(entry: AuditEntry): Promise<void> {
    let backoff = this.initialBackoffMs;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await this.attemptOnce(entry);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt === this.maxAttempts) break;
        await this.sleepImpl(backoff);
        backoff = Math.min(backoff * 2, this.maxBackoffMs);
      }
    }
    if (this.deadLetterFile) {
      try {
        await appendFile(
          this.deadLetterFile,
          JSON.stringify(entry) + "\n",
          "utf8",
        );
      } catch (writeErr) {
        console.warn(
          "WebhookSink: DLQ write failed: %s",
          writeErr instanceof Error ? writeErr.message : String(writeErr),
        );
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(String(lastErr ?? "webhook delivery failed"));
  }

  private async attemptOnce(entry: AuditEntry): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.headers,
    };
    if (this.token) headers["authorization"] = `Bearer ${this.token}`;

    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.requestTimeoutMs).unref?.();
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(entry),
        signal: ctl.signal,
      });
      if (!res.ok) {
        // Read+discard so the connection releases. Limit body so a
        // misbehaving receiver can't make the gateway page in MB of
        // text per failure.
        const snippet = (await res.text().catch(() => "")).slice(0, 200);
        throw new Error(
          `webhook returned ${res.status} ${res.statusText}: ${snippet}`,
        );
      }
    } finally {
      if (typeof t === "object" && t) clearTimeout(t);
    }
  }
}
