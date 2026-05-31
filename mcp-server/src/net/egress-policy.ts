/**
 * Verifiable offline mode — egress policy.
 *
 * The server performs **no telemetry, analytics, phone-home, or update
 * checks**. The only outbound network calls it ever makes are to backends
 * the operator explicitly configures (Prometheus/Loki/... source URLs) or to
 * an artifact URL the operator/registry explicitly asks it to install.
 *
 * This module is the machine-checkable statement of that guarantee:
 * `egress-policy.test.ts` fails CI if any source file outside the allowlist
 * introduces an outbound call — so the "no data egress" property cannot
 * silently regress.
 */

export const OFFLINE_STATEMENT =
  "observability-mcp makes no telemetry/analytics/phone-home/update calls. " +
  "Outbound traffic goes only to operator-configured source backends and " +
  "operator/registry-requested plugin artifacts. It runs fully air-gapped.";

/** Regex of outbound-call shapes the guard scans for. */
export const OUTBOUND_PATTERN =
  /\b(fetch\s*\(|https?\.request\s*\(|new\s+WebSocket\s*\(|import\s*\(\s*['"]https?:)/;

/**
 * Files/prefixes permitted to make outbound calls, each with the reason.
 * Anything matching OUTBOUND_PATTERN outside these paths is a policy breach
 * (e.g. a newly added analytics/telemetry module).
 */
export const EGRESS_ALLOWLIST: ReadonlyArray<{ prefix: string; reason: string }> = [
  { prefix: "connectors/", reason: "connectors query operator-configured source backends" },
  { prefix: "cli/index.ts", reason: "CLI fetches a source location the operator passed explicitly" },
  { prefix: "index.ts", reason: "connector-hub plugin install of an operator/registry-requested tarball URL" },
  { prefix: "auth/oidc/", reason: "OIDC client calls the operator-configured OMCP_OIDC_ISSUER for discovery, JWKS, and code-exchange" },
  { prefix: "auth/policy/", reason: "OpaPolicyEngine queries the operator-configured OMCP_OPA_URL on every RBAC decision" },
];

/**
 * Hard-blocked analytics/telemetry SDKs — matches an *import/require of the
 * package*, not the word in prose, so comments/policy text don't false-positive.
 */
export const FORBIDDEN_TELEMETRY =
  /(?:from\s*['"]|require\(\s*['"])[^'"]*(sentry|posthog|mixpanel|amplitude|@segment|datadog-rum|analytics-node|google-analytics)/i;

export function isEgressAllowed(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/");
  return EGRESS_ALLOWLIST.some((a) => p === a.prefix || p.startsWith(a.prefix));
}
