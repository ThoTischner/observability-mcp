// SSRF strict-mode for operator-supplied URLs.
//
// Connectors (Prometheus, Loki, Tempo, Grafana, generic webhook
// targets) all take a URL the operator types in. Without a guard, an
// admin who can add a source can also probe cloud-metadata endpoints
// (169.254.169.254 → IAM creds, GCE service accounts, etc.) or other
// in-cluster services that should not be reachable from the gateway.
//
// This module rejects URLs whose hostname:
//   - is a private/loopback/link-local IPv4 or IPv6 literal, OR
//   - is the well-known cloud-metadata IP, OR
//   - resolves (when an explicit IP is set) to one of the above
//
// Operators who legitimately need to reach an in-cluster Prometheus
// (a frequent case) opt out via OMCP_ALLOW_PRIVATE_BACKENDS=true.

import { isIP } from "node:net";

// IPv4 IMDS (AWS / GCE / Azure / Oracle) all share 169.254.169.254.
// fd00:ec2::254 is the AWS IMDS IPv6 address.
const METADATA_IPS = new Set(["169.254.169.254", "fd00:ec2::254"]);

// Private IPv4 ranges per RFC 1918/3927/6890. String-prefix matching
// is intentionally lo-fi — the guard catches typed-by-hand URLs, not
// every numerical corner. A DNS-resolved guard is on the F11b list.
const IPV4_PREFIXES = [
  "10.", // RFC1918
  "172.16.", "172.17.", "172.18.", "172.19.",
  "172.20.", "172.21.", "172.22.", "172.23.",
  "172.24.", "172.25.", "172.26.", "172.27.",
  "172.28.", "172.29.", "172.30.", "172.31.",
  "192.168.", // RFC1918
  "169.254.", // link-local + cloud metadata
  "127.", // loopback
  "0.", // 0.0.0.0/8
];

const IPV6_PRIVATE_PREFIXES = [
  "::1", // loopback
  "fc", // unique-local (fc00::/7)
  "fd", // unique-local
  "fe8", // link-local (fe80::/10)
  "fe9",
  "fea",
  "feb",
];

export interface SsrfGuardConfig {
  allowPrivateBackends: boolean;
}

export function ssrfGuardFromEnv(env: NodeJS.ProcessEnv = process.env): SsrfGuardConfig {
  return {
    allowPrivateBackends: /^(1|true|yes|on)$/i.test(env.OMCP_ALLOW_PRIVATE_BACKENDS ?? ""),
  };
}

export interface SsrfGuardVerdict {
  allow: boolean;
  reason?: string;
}

/** Inspect a URL and decide whether the connector layer should be
 *  allowed to dial it. Cheap, synchronous, hostname-only — does not
 *  resolve DNS. (DNS resolution would still leak the request, so the
 *  guard would have to additionally pin the resolved IP at connect
 *  time. That's worth doing in a follow-up; for now we catch the
 *  most-frequent typed-IP cases and document the resolver limitation.) */
export function checkOutboundUrl(rawUrl: string, cfg: SsrfGuardConfig): SsrfGuardVerdict {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    return { allow: false, reason: `invalid URL: ${(err as Error).message}` };
  }
  if (!/^https?:$/i.test(parsed.protocol)) {
    return { allow: false, reason: `unsupported protocol: ${parsed.protocol}` };
  }
  // URL parser keeps IPv6 brackets on .hostname ("[::1]"); strip
  // them before isIP / prefix matching so the rest of the guard is
  // shape-agnostic.
  let hostname = parsed.hostname.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  if (METADATA_IPS.has(hostname)) {
    return {
      allow: false,
      reason: `cloud-metadata IP ${hostname} is rejected (set OMCP_ALLOW_PRIVATE_BACKENDS=true to override)`,
    };
  }
  if (cfg.allowPrivateBackends) {
    return { allow: true };
  }
  const v = isIP(hostname);
  if (v === 4) {
    for (const p of IPV4_PREFIXES) {
      if (hostname.startsWith(p)) {
        return {
          allow: false,
          reason: `private IPv4 ${hostname} is rejected (set OMCP_ALLOW_PRIVATE_BACKENDS=true to allow in-cluster backends)`,
        };
      }
    }
  } else if (v === 6) {
    for (const p of IPV6_PRIVATE_PREFIXES) {
      if (hostname.startsWith(p)) {
        return {
          allow: false,
          reason: `private IPv6 ${hostname} is rejected (set OMCP_ALLOW_PRIVATE_BACKENDS=true to allow in-cluster backends)`,
        };
      }
    }
  }
  return { allow: true };
}
