/**
 * Conservative PII / secret redaction for tool outputs that may contain
 * arbitrary log payloads.
 *
 * Scope of this module: pure string redaction with deterministic
 * patterns. Returns the rewritten string plus a per-category count so
 * callers can surface a "redacted N matches" hint to the user / agent
 * without leaking what was matched. Designed to be safe-by-default
 * (over-redact rather than under-redact) and explicit (each category
 * tagged in the replacement marker, e.g. `[redacted-email]`).
 *
 * Bypass is the operator's call: in basic mode a session with the
 * `redaction:bypass` permission may opt out per-request.
 */

export type RedactionCategory =
  | "email"
  | "ipv4"
  | "ipv6"
  | "bearer"
  | "jwt"
  | "api-key";

export interface RedactionResult {
  text: string;
  matches: Record<RedactionCategory, number>;
  totalMatches: number;
}

// Patterns chosen for low false-positive on operational log text:
// - Email: standard local@domain.tld with limited TLD chars.
// - IPv4: strict 0-255 quads to avoid matching version numbers etc.
// - IPv6: full / compressed; we accept the common forms only.
// - Bearer: "Authorization: Bearer <token>" — pulls the token out.
// - JWT: 3-part base64url joined by dots.
// - Generic API-key: long alnum + base64-ish run after a key= marker.
const PATTERNS: Array<{ category: RedactionCategory; re: RegExp }> = [
  // emails first so they don't get partially matched by other patterns
  { category: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g },
  { category: "jwt", re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { category: "bearer", re: /\b[Bb]earer\s+[A-Za-z0-9._\-+/=]{12,}\b/g },
  { category: "api-key", re: /\b(?:api[_-]?key|x-api-key|token|secret)[=:]\s*['"]?[A-Za-z0-9._\-+/=]{16,}['"]?/gi },
  { category: "ipv4", re: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g },
  // simple ipv6: 8 groups of 1-4 hex digits, or :: compression with at least one group on each side.
  // ipv6 — covers full, mid-compressed, leading "::loopback" / "::ffff:v4"
  // mapped forms, and "::1". Trailing-only `xxxx::` shapes are rare in
  // operational logs and intentionally not covered.
  { category: "ipv6", re: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,6}(?::[0-9a-fA-F]{1,4}){1,6}\b|::1\b|::ffff:(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g },
];

function emptyCounts(): Record<RedactionCategory, number> {
  return { email: 0, ipv4: 0, ipv6: 0, bearer: 0, jwt: 0, "api-key": 0 };
}

/** Run all patterns in a deterministic order; later patterns won't
 * re-match content already replaced by an earlier one (the marker
 * starts with `[redacted-` which none of the patterns match). */
export function redactText(input: string): RedactionResult {
  const matches = emptyCounts();
  let text = input;
  for (const { category, re } of PATTERNS) {
    text = text.replace(re, () => {
      matches[category] += 1;
      return `[redacted-${category}]`;
    });
  }
  let total = 0;
  for (const k of Object.keys(matches) as RedactionCategory[]) total += matches[k];
  return { text, matches, totalMatches: total };
}

/** Walk an arbitrary parsed-JSON value and redact every string leaf,
 * accumulating match counts. Non-string leaves and structural keys are
 * left untouched. Returns a new value (does not mutate input). */
export function redactValue(input: unknown): { value: unknown; matches: Record<RedactionCategory, number>; totalMatches: number } {
  const counts = emptyCounts();
  function walk(v: unknown): unknown {
    if (typeof v === "string") {
      const r = redactText(v);
      for (const k of Object.keys(counts) as RedactionCategory[]) counts[k] += r.matches[k];
      return r.text;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) out[k] = walk(vv);
      return out;
    }
    return v;
  }
  const value = walk(input);
  let total = 0;
  for (const k of Object.keys(counts) as RedactionCategory[]) total += counts[k];
  return { value, matches: counts, totalMatches: total };
}
