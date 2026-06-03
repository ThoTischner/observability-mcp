/**
 * Anomaly-deduper for the demo agent.
 *
 * Pulled out of index.ts so the dedup contract can be unit-tested
 * without spinning up the full agent + Ollama + MCP stack:
 *
 *   - Same (service, metric, severity) reported within the TTL = dup
 *   - Past the TTL, the same triple counts as new again
 *   - cleanExpired() drops stale entries so the Map doesn't grow
 *     unboundedly over a long agent run
 *
 * `now` is injected so tests can step time deterministically; the
 * default uses Date.now() so the production code stays a one-liner.
 */
export interface AnomalyKey {
  service: string;
  metric: string;
  severity: string;
}

export function anomalyHash(a: AnomalyKey): string {
  return `${a.service}:${a.metric}:${a.severity}`;
}

export class IncidentDeduper {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when an anomaly with this (service, metric, severity)
   *  was already reported inside the TTL window. */
  isDuplicate(a: AnomalyKey): boolean {
    const at = this.seen.get(anomalyHash(a));
    return at !== undefined && this.now() - at < this.ttlMs;
  }

  /** Record this anomaly as just-reported. Subsequent isDuplicate
   *  calls inside the TTL window return true. */
  markReported(a: AnomalyKey): void {
    this.seen.set(anomalyHash(a), this.now());
  }

  /** Drop entries older than the TTL so the map doesn't grow
   *  unboundedly. The agent calls this periodically; not strictly
   *  necessary for correctness — isDuplicate already treats expired
   *  entries as non-duplicates. */
  cleanExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [hash, at] of this.seen) {
      if (at <= cutoff) this.seen.delete(hash);
    }
  }

  /** Snapshot the live entry count — useful for /metrics-style
   *  introspection and assertions in tests. */
  size(): number {
    return this.seen.size;
  }
}
