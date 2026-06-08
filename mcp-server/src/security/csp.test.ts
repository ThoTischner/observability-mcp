import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateNonce,
  enforcedCsp,
  reportOnlyCsp,
  reportingEndpointsHeader,
  reportToHeader,
  summariseViolation,
  cspStrictReportFromEnv,
  CSP_NONCE_PLACEHOLDER,
  CSP_REPORT_GROUP,
  CSP_REPORT_PATH,
} from "./csp.js";

test("generateNonce returns a fresh base64 value each call", () => {
  const a = generateNonce();
  const b = generateNonce();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9+/]+=*$/);
  // 16 bytes → 24 base64 chars (with padding).
  assert.ok(a.length >= 22);
});

test("enforced policy keeps the UI working but locks the rest down", () => {
  const csp = enforcedCsp();
  // Inline handlers survive: unsafe-inline present, NO nonce (which would disable it).
  assert.match(csp, /script-src 'self' 'unsafe-inline'/);
  assert.ok(!csp.includes("nonce-"), "enforced policy must not carry a nonce");
  // Hard locks.
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /connect-src 'self'/);
  // Reporting wired both ways.
  assert.match(csp, new RegExp(`report-uri ${CSP_REPORT_PATH}`));
  assert.match(csp, new RegExp(`report-to ${CSP_REPORT_GROUP}`));
});

test("report-only policy is strict and nonce-bound, no unsafe-inline on scripts", () => {
  const nonce = generateNonce();
  const csp = reportOnlyCsp(nonce);
  assert.match(csp, new RegExp(`script-src 'self' 'nonce-${nonce.replace(/[+/]/g, "\\$&")}'`));
  // Strict: the script directive must NOT allow unsafe-inline.
  const scriptDirective = csp.split(";").find((d) => d.trim().startsWith("script-src"))!;
  assert.ok(!scriptDirective.includes("unsafe-inline"));
  assert.match(csp, /object-src 'none'/);
});

test("reporting headers name the same group + endpoint", () => {
  assert.equal(reportingEndpointsHeader(), `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`);
  const parsed = JSON.parse(reportToHeader());
  assert.equal(parsed.group, CSP_REPORT_GROUP);
  assert.equal(parsed.endpoints[0].url, CSP_REPORT_PATH);
  assert.ok(parsed.max_age > 0);
});

test("the nonce placeholder is a stable token", () => {
  assert.equal(CSP_NONCE_PLACEHOLDER, "__CSP_NONCE__");
});

test("strict report-only is opt-in (default off)", () => {
  assert.equal(cspStrictReportFromEnv({} as NodeJS.ProcessEnv), false);
  assert.equal(cspStrictReportFromEnv({ OMCP_CSP_STRICT_REPORT: "true" } as NodeJS.ProcessEnv), true);
  assert.equal(cspStrictReportFromEnv({ OMCP_CSP_STRICT_REPORT: "1" } as NodeJS.ProcessEnv), true);
  assert.equal(cspStrictReportFromEnv({ OMCP_CSP_STRICT_REPORT: "no" } as NodeJS.ProcessEnv), false);
  assert.equal(cspStrictReportFromEnv({ OMCP_CSP_STRICT_REPORT: "false" } as NodeJS.ProcessEnv), false);
});

test("summariseViolation parses the legacy csp-report envelope", () => {
  const s = summariseViolation({
    "csp-report": {
      "effective-directive": "script-src-attr",
      "blocked-uri": "inline",
      "document-uri": "https://gw.example/",
      "extra": "ignored",
    },
  });
  assert.deepEqual(s, {
    directive: "script-src-attr",
    blockedUri: "inline",
    documentUri: "https://gw.example/",
  });
});

test("summariseViolation parses a modern Reporting-API array", () => {
  const s = summariseViolation([
    {
      type: "csp-violation",
      body: {
        effectiveDirective: "script-src-elem",
        blockedURL: "https://evil.example/x.js",
        documentURL: "https://gw.example/",
      },
    },
  ]);
  assert.equal(s?.directive, "script-src-elem");
  assert.equal(s?.blockedUri, "https://evil.example/x.js");
});

test("summariseViolation falls back to violated-directive", () => {
  const s = summariseViolation({ "csp-report": { "violated-directive": "img-src", "blocked-uri": "data" } });
  assert.equal(s?.directive, "img-src");
});

test("summariseViolation returns null for junk", () => {
  assert.equal(summariseViolation(null), null);
  assert.equal(summariseViolation("nope"), null);
  assert.equal(summariseViolation({}), null);
  assert.equal(summariseViolation({ random: "field" }), null);
});

test("summariseViolation truncates over-long fields", () => {
  const long = "a".repeat(5000);
  const s = summariseViolation({ "csp-report": { "blocked-uri": long } });
  assert.ok(s);
  assert.ok((s!.blockedUri).length <= 256);
});
