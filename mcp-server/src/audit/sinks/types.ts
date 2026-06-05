import type { AuditEntry } from "../log.js";

/**
 * A destination that receives every chained audit entry. The on-disk
 * JSONL chain stays the authoritative master (so the hash chain is
 * never split-brain across sinks); sinks are mirrors for SIEM /
 * archive / webhook fan-out.
 *
 * write() must NEVER throw — sinks log+swallow internally. A sink that
 * dies must not take down the management plane.
 */
export interface AuditSink {
  /** Stable identifier, used in logs and env selection. */
  readonly name: string;
  /** Persist one chained entry. Best-effort; failures are logged. */
  write(entry: AuditEntry): Promise<void>;
  /** Flush any buffered state. Called on SIGTERM and in tests. */
  flush?(): Promise<void>;
}
