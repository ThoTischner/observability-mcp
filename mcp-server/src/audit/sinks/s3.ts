// S3Sink: ship audit entries to an S3-compatible object store
// (AWS S3, MinIO, Cloudflare R2, Backblaze B2, Wasabi, …).
//
// Buffer audit entries in memory; every flush window (default 60 s)
// or whenever the buffer crosses the cap (default 1000 entries),
// concatenate as JSONL and PUT one object under
// `<prefix>/YYYY/MM/DD/HH/<minute>-<seqStart>-<seqEnd>.jsonl`.
//
// Why per-minute rollups, not per-entry? S3 charges per PUT (5x per
// LIST / 1x per GET). An audit-heavy gateway generates 100s of
// entries/minute — per-entry PUT is wasteful on cost AND on SDK
// concurrency. One PUT/min keeps the bill low and still lets the
// operator scrape a minute-grained timeline in the storage console.
//
// Failures dead-letter to a local JSONL so a recovered S3 backend
// can be replayed by an external tool. The on-disk audit chain stays
// the authoritative master.

import { appendFile } from "node:fs/promises";

import type { AuditEntry } from "../log.js";
import type { AuditSink } from "./types.js";

let _sdk: { S3Client: unknown; PutObjectCommand: unknown } | null = null;
async function loadSdk(): Promise<{ S3Client: unknown; PutObjectCommand: unknown }> {
  if (_sdk) return _sdk;
  const s3 = await import("@aws-sdk/client-s3");
  _sdk = { S3Client: s3.S3Client, PutObjectCommand: s3.PutObjectCommand };
  return _sdk;
}

/** Minimal subset of the AWS SDK S3Client we depend on. */
export interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
}

export interface S3SinkOptions {
  /** Target bucket. Required. */
  bucket: string;
  /** Region — required for AWS, ignored by MinIO. Default us-east-1. */
  region?: string;
  /**
   * Object key prefix. Default empty. The final key is
   * `<prefix>/YYYY/MM/DD/HH/<minute>-<seqStart>-<seqEnd>.jsonl`.
   * Trailing slash optional.
   */
  prefix?: string;
  /**
   * Override the AWS endpoint URL for S3-compatible backends
   * (MinIO, R2, B2). Empty = use AWS regional endpoint.
   */
  endpoint?: string;
  /** Force path-style addressing — required for MinIO + B2. */
  forcePathStyle?: boolean;
  /** Flush every N milliseconds. Default 60000 (1 minute). */
  flushIntervalMs?: number;
  /** Flush when buffer holds N entries. Default 1000. */
  maxBufferSize?: number;
  /** Optional path for unrecoverable batches. */
  deadLetterFile?: string;
  /** Inject a client for unit tests. */
  client?: S3ClientLike;
}

export class S3Sink implements AuditSink {
  readonly name = "s3";
  private readonly bucket: string;
  private readonly region: string;
  private readonly prefix: string;
  private readonly endpoint?: string;
  private readonly forcePathStyle: boolean;
  private readonly flushIntervalMs: number;
  private readonly maxBufferSize: number;
  private readonly deadLetterFile?: string;

  private client: S3ClientLike | null = null;
  private putCommand: { new (input: unknown): unknown } | null = null;
  private sdkLoadError: string | null = null;
  private buffer: AuditEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(opts: S3SinkOptions) {
    if (!opts.bucket) throw new Error("S3Sink: bucket is required");
    this.bucket = opts.bucket;
    this.region = opts.region ?? process.env.AWS_REGION ?? "us-east-1";
    // Normalise to "prefix/" form (trailing slash) when non-empty so
    // we don't ever build `<prefix>YYYY/...` with a missing slash.
    const rawPrefix = (opts.prefix ?? "").replace(/^\/+|\/+$/g, "");
    this.prefix = rawPrefix ? `${rawPrefix}/` : "";
    this.endpoint = opts.endpoint || undefined;
    this.forcePathStyle = opts.forcePathStyle ?? false;
    this.flushIntervalMs = opts.flushIntervalMs ?? 60_000;
    this.maxBufferSize = opts.maxBufferSize ?? 1_000;
    this.deadLetterFile = opts.deadLetterFile;

    if (opts.client) {
      this.client = opts.client;
      // Tests inject a fake client AND need PutObjectCommand to be
      // construct-able as a plain class. We stub here so the
      // command-pattern API surface still works.
      const Stub = class { input: unknown; constructor(input: unknown) { this.input = input; } };
      Object.defineProperty(Stub, "name", { value: "PutObjectCommand" });
      this.putCommand = Stub as unknown as { new (input: unknown): unknown };
    }
  }

  /** Resolve the SDK lazily so the gateway still boots if @aws-sdk/client-s3
   *  isn't installed. Called on the first flush attempt only. */
  private async ensureClient(): Promise<boolean> {
    if (this.client && this.putCommand) return true;
    if (this.sdkLoadError) return false;
    try {
      const sdk = await loadSdk();
      const S3Client = sdk.S3Client as { new (cfg: unknown): S3ClientLike };
      this.client = new S3Client({
        region: this.region,
        endpoint: this.endpoint,
        forcePathStyle: this.forcePathStyle,
      });
      this.putCommand = sdk.PutObjectCommand as { new (input: unknown): unknown };
      return true;
    } catch (err) {
      this.sdkLoadError = err instanceof Error ? err.message : String(err);
      console.warn("S3Sink: @aws-sdk/client-s3 not installed (%s) — entries will dead-letter", this.sdkLoadError);
      return false;
    }
  }

  async write(entry: AuditEntry): Promise<void> {
    this.buffer.push(entry);
    if (!this.flushTimer && this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => { void this.flush(); }, this.flushIntervalMs);
      if (this.flushTimer && typeof this.flushTimer.unref === "function") {
        this.flushTimer.unref();
      }
    }
    if (this.buffer.length >= this.maxBufferSize) {
      // Buffer cap reached — flush in background, never block record().
      this.writeQueue = this.writeQueue.then(() => this.flushNow());
    }
  }

  async flush(): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => this.flushNow());
    await this.writeQueue;
  }

  /** Stop the timer + flush remaining. Called on SIGTERM. */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  // --- internals ----------------------------------------------------

  private async flushNow(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);

    const ok = await this.ensureClient();
    if (!ok) {
      await this.deadLetter(batch);
      return;
    }

    const body = batch.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const key = this.buildKey(batch);
    try {
      const cmd = new this.putCommand!({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: "application/x-ndjson",
        // Server-side encryption when running on AWS. MinIO + R2 + B2
        // ignore the header gracefully.
        ServerSideEncryption: "AES256",
      });
      await this.client!.send(cmd);
    } catch (err) {
      console.warn(
        "S3Sink: PUT s3://%s/%s failed: %s — batch dead-letters",
        this.bucket,
        key,
        err instanceof Error ? err.message : String(err),
      );
      await this.deadLetter(batch);
    }
  }

  private buildKey(batch: AuditEntry[]): string {
    // Derive the time bucket from the first entry's timestamp so a
    // late-arriving entry stays grouped with its peers.
    const t = new Date(batch[0]?.ts ?? new Date().toISOString());
    const yyyy = String(t.getUTCFullYear());
    const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(t.getUTCDate()).padStart(2, "0");
    const hh = String(t.getUTCHours()).padStart(2, "0");
    const mi = String(t.getUTCMinutes()).padStart(2, "0");
    const seqStart = batch[0]?.seq ?? 0;
    const seqEnd = batch[batch.length - 1]?.seq ?? seqStart;
    return `${this.prefix}${yyyy}/${mm}/${dd}/${hh}/${mi}-${seqStart}-${seqEnd}.jsonl`;
  }

  private async deadLetter(batch: AuditEntry[]): Promise<void> {
    if (!this.deadLetterFile) {
      console.warn("S3Sink: %d entries dropped (no deadLetterFile configured)", batch.length);
      return;
    }
    try {
      const body = batch.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await appendFile(this.deadLetterFile, body, "utf8");
    } catch (err) {
      console.warn("S3Sink: DLQ write failed: %s", err instanceof Error ? err.message : String(err));
    }
  }
}
