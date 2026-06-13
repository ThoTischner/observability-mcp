// Inspect — argument-shape derivation.
//
// Turns a tool call's (already-redacted) arguments into a coarse, learnable
// *signature*: the resource dimensions it targeted (source / service /
// namespace — the equivalent of AppArmor's file paths) plus a bucketed shape
// of the remaining scalar args. We deliberately never keep literal argument
// values (especially free-text PromQL/LogQL queries) — only their shape — so
// the store stays small, privacy-preserving, and the profile generalises
// instead of memorising one exact call.

/** The resource dimensions we treat as first-class (real values kept). */
export const RESOURCE_KEYS = ["source", "service", "namespace"] as const;
export type ResourceKey = (typeof RESOURCE_KEYS)[number];

export interface Signature {
  source?: string;
  service?: string;
  namespace?: string;
  /** key → coarse bucket label (e.g. window → "<=1h", ips → "n=11-100"). */
  argShape: Record<string, string>;
}

/** Bucket a count/length into coarse, order-of-magnitude bands. */
export function countBucket(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n <= 1) return "1";
  if (n <= 10) return "2-10";
  if (n <= 100) return "11-100";
  if (n <= 1000) return "101-1000";
  return ">1000";
}

/** Parse a Prometheus/Loki-style duration (e.g. "5m", "1h30m", "90s", "2d")
 *  to seconds. Returns null when it isn't a duration string. */
export function durationToSeconds(s: string): number | null {
  const str = s.trim();
  if (!/^\d+(?:\.\d+)?(?:ms|s|m|h|d|w|y)(?:\d+(?:\.\d+)?(?:ms|s|m|h|d|w|y))*$/.test(str)) {
    return null;
  }
  const unit: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 };
  let total = 0;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(str)) !== null) {
    total += parseFloat(match[1]) * unit[match[2]];
  }
  return total;
}

/** Bucket a duration (seconds) into coarse time bands. */
export function durationBucket(s: string): string {
  const secs = durationToSeconds(s);
  if (secs === null) return "other";
  if (secs <= 300) return "<=5m";
  if (secs <= 3600) return "<=1h";
  if (secs <= 86400) return "<=1d";
  return ">1d";
}

/** Bucket a bare number into small / medium / large bands. */
export function numBucket(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n <= 10) return "<=10";
  if (n <= 100) return "<=100";
  if (n <= 1000) return "<=1000";
  return ">1000";
}

/** Keys whose string value should be treated as a duration when parseable. */
const DURATION_KEY = /window|range|lookback|step|interval|since|duration|period|timeout/i;

/**
 * Derive a Signature from a tool name + its (redacted) arguments.
 * Deterministic and pure — same input always yields the same signature.
 */
export function deriveSignature(_tool: string, args: unknown): Signature {
  const sig: Signature = { argShape: {} };
  if (!args || typeof args !== "object" || Array.isArray(args)) return sig;
  const a = args as Record<string, unknown>;

  for (const k of RESOURCE_KEYS) {
    const v = a[k];
    if (typeof v === "string" && v.trim()) sig[k] = v.trim();
  }

  for (const [k, v] of Object.entries(a)) {
    if ((RESOURCE_KEYS as readonly string[]).includes(k)) continue;
    // Never let a prototype-polluting arg name into the shape map (keys come
    // from arbitrary tool-call arguments — js/remote-property-injection).
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (Array.isArray(v)) {
      sig.argShape[k] = "n=" + countBucket(v.length);
    } else if (typeof v === "number") {
      sig.argShape[k] = numBucket(v);
    } else if (typeof v === "boolean") {
      sig.argShape[k] = v ? "true" : "false";
    } else if (typeof v === "string") {
      if (DURATION_KEY.test(k) && durationToSeconds(v) !== null) {
        sig.argShape[k] = durationBucket(v);
      } else {
        // Free-text values (queries, ids, names) collapse to "present" — we
        // never persist the literal.
        sig.argShape[k] = v.trim() ? "present" : "empty";
      }
    } else if (v && typeof v === "object") {
      sig.argShape[k] = "object";
    }
  }
  return sig;
}
