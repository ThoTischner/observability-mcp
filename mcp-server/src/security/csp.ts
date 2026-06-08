/**
 * Content-Security-Policy for the management-plane Web UI.
 *
 * Two policies ship together, by design:
 *
 *  - **Enforced** (`Content-Security-Policy`): a real, non-breaking policy.
 *    It locks down everything the UI doesn't need — no remote scripts
 *    (`script-src 'self'`), no plugins (`object-src 'none'`), no `<base>`
 *    hijack (`base-uri 'self'`), no framing (`frame-ancestors 'none'`),
 *    and same-origin-only XHR via `connect-src 'self'`. It keeps
 *    `'unsafe-inline'` for `script-src` because the single-file UI uses
 *    ~200 inline event-handler attributes (`onclick=`, …) that a nonce
 *    cannot cover — a nonce in `script-src` would *disable* `'unsafe-inline'`
 *    in CSP3 and break every button. So the enforced policy is a genuine
 *    improvement over no CSP without regressing the UI.
 *
 *  - **Report-Only** (`Content-Security-Policy-Report-Only`): the strict
 *    target policy — `script-src 'self' 'nonce-…'`, no `'unsafe-inline'`.
 *    The two legitimate inline `<script>` blocks carry the per-request
 *    nonce, so this policy flags ONLY the inline event-handler debt. It
 *    blocks nothing; it just reports, giving an actionable migration list
 *    (move the handlers to addEventListener) before a future slice can
 *    promote the strict policy to enforced.
 *
 * Both policies report to `/api/csp-violations` via the modern Reporting
 * API (`Reporting-Endpoints` + `report-to`) and the legacy `report-uri`.
 */

import { randomBytes } from "node:crypto";

/** Placeholder substituted with the per-request nonce when serving the UI HTML. */
export const CSP_NONCE_PLACEHOLDER = "__CSP_NONCE__";

/** The named reporting group used in the Report-To / Reporting-Endpoints headers. */
export const CSP_REPORT_GROUP = "omcp-csp";

/** Where violation reports are POSTed. */
export const CSP_REPORT_PATH = "/api/csp-violations";

/** Fresh base64 nonce (128 bits). */
export function generateNonce(): string {
  return randomBytes(16).toString("base64");
}

/** The enforced policy — non-breaking, keeps the UI working. */
export function enforcedCsp(): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${CSP_REPORT_GROUP}`,
  ].join("; ");
}

/** The strict target policy, run in report-only mode against the nonce. */
export function reportOnlyCsp(nonce: string): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${CSP_REPORT_GROUP}`,
  ].join("; ");
}

/** Value for the modern `Reporting-Endpoints` header. */
export function reportingEndpointsHeader(): string {
  return `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`;
}

/** Value for the legacy `Report-To` header (Reporting API v0). */
export function reportToHeader(): string {
  return JSON.stringify({
    group: CSP_REPORT_GROUP,
    max_age: 10886400,
    endpoints: [{ url: CSP_REPORT_PATH }],
  });
}

/**
 * Normalise a posted CSP violation (either the legacy
 * `application/csp-report` `{ "csp-report": {...} }` envelope or a modern
 * Reporting-API `application/reports+json` array element) into a compact,
 * log-safe summary. Returns null when the body isn't a recognisable report.
 */
export function summariseViolation(body: unknown): {
  directive: string;
  blockedUri: string;
  documentUri: string;
} | null {
  if (!body || typeof body !== "object") return null;
  // Reporting API delivers an array of { type, body: {...} }.
  if (Array.isArray(body)) {
    for (const item of body) {
      const s = summariseViolation(item);
      if (s) return s;
    }
    return null;
  }
  const o = body as Record<string, unknown>;
  // Reporting-API single report: { type: "csp-violation", body: {...} }.
  const report = (o["csp-report"] ?? o.body ?? o) as Record<string, unknown>;
  if (!report || typeof report !== "object") return null;
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = report[k];
      if (typeof v === "string" && v) return v.slice(0, 256);
    }
    return "";
  };
  const directive = pick("effective-directive", "effectiveDirective", "violated-directive", "violatedDirective");
  const blockedUri = pick("blocked-uri", "blockedURL", "blockedURI");
  const documentUri = pick("document-uri", "documentURL", "documentURI");
  if (!directive && !blockedUri && !documentUri) return null;
  return { directive, blockedUri, documentUri };
}
