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
  | "api-key"
  | "aws-key"
  | "slack-token"
  | "private-key"
  | "gh-pat"
  | "credit-card";

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
  // High-confidence cloud-vendor secrets go first — their prefixes are
  // distinctive enough that they don't conflict with generic patterns.
  // - AWS access key id: 16-32 chars after AKIA/ASIA/AROA prefix.
  // - Slack tokens: xoxa-/xoxb-/xoxp-/xoxr-/xoxs- + 10+ chars.
  // - GitHub PAT: github_pat_<base62 segments> or ghp_/gho_/ghs_/ghu_/ghr_ + 36 chars.
  // - PEM private-key blocks: greedy match across newlines.
  { category: "aws-key", re: /\b(?:AKIA|ASIA|AROA)[0-9A-Z]{16,20}\b/g },
  { category: "slack-token", re: /\bxox[abprsu]-[A-Za-z0-9-]{10,}\b/g },
  { category: "gh-pat", re: /\b(?:github_pat_[A-Za-z0-9_]{40,}|gh[opsuru]_[A-Za-z0-9]{36})\b/g },
  { category: "private-key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g },

  // emails before other patterns so they don't get eaten partially
  { category: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g },
  { category: "jwt", re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { category: "bearer", re: /\b[Bb]earer\s+[A-Za-z0-9._\-+/=]{12,}\b/g },
  { category: "api-key", re: /\b(?:api[_-]?key|x-api-key|token|secret)[=:]\s*['"]?[A-Za-z0-9._\-+/=]{16,}['"]?/gi },
  { category: "ipv4", re: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g },
  // ipv6 — covers full, mid-compressed, leading "::loopback" / "::ffff:v4"
  // mapped forms, and "::1". Trailing-only `xxxx::` shapes are rare in
  // operational logs and intentionally not covered.
  { category: "ipv6", re: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,6}(?::[0-9a-fA-F]{1,4}){1,6}\b|::1\b|::ffff:(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g },
];

function emptyCounts(): Record<RedactionCategory, number> {
  return {
    email: 0, ipv4: 0, ipv6: 0, bearer: 0, jwt: 0, "api-key": 0,
    "aws-key": 0, "slack-token": 0, "private-key": 0, "gh-pat": 0,
    "credit-card": 0,
  };
}

/** Luhn check — accepts digits-only string of 13–19 chars. Used to
 * keep the credit-card redaction from over-matching random digit
 * strings (order IDs, timestamps, etc.). */
function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
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
  // Credit-card pass runs last so an inner-substring of a longer
  // already-redacted token can't accidentally match. Luhn-validated
  // so order numbers / timestamps / random digit strings stay intact.
  text = text.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19) return match;
    if (!luhn(digits)) return match;
    matches["credit-card"] += 1;
    return "[redacted-credit-card]";
  });
  let total = 0;
  for (const k of Object.keys(matches) as RedactionCategory[]) total += matches[k];
  return { text, matches, totalMatches: total };
}

/** Maximum nesting depth the walker will descend into. Operational
 * log payloads are essentially flat (objects of strings + a few
 * nested arrays); a pathologically deep structure is almost certainly
 * a bug or an attack, and stack-overflowing the auth path is worse
 * than truncating. The cap is generous — well above anything a
 * Prometheus / Loki record would ever produce. */
export const MAX_REDACT_DEPTH = 64;

/** Walk an arbitrary parsed-JSON value and redact every string leaf,
 * accumulating match counts. Non-string leaves and structural keys are
 * left untouched. Returns a new value (does not mutate input). Bails
 * out below `MAX_REDACT_DEPTH` levels of nesting and returns the raw
 * sub-tree untouched at that point. */
export function redactValue(input: unknown): { value: unknown; matches: Record<RedactionCategory, number>; totalMatches: number } {
  const counts = emptyCounts();
  function walk(v: unknown, depth: number): unknown {
    if (depth > MAX_REDACT_DEPTH) return v;
    if (typeof v === "string") {
      const r = redactText(v);
      for (const k of Object.keys(counts) as RedactionCategory[]) counts[k] += r.matches[k];
      return r.text;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) out[k] = walk(vv, depth + 1);
      return out;
    }
    return v;
  }
  const value = walk(input, 0);
  let total = 0;
  for (const k of Object.keys(counts) as RedactionCategory[]) total += counts[k];
  return { value, matches: counts, totalMatches: total };
}
