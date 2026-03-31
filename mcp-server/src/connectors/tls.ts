import { Agent, AgentOptions } from "node:https";
import { readFileSync } from "node:fs";
import type { SourceConfig } from "../types.js";

/**
 * Build an https.Agent from a SourceConfig's TLS settings.
 * Returns undefined if no custom TLS config is needed (plain HTTP or default HTTPS).
 */
export function buildTlsAgent(config: SourceConfig): Agent | undefined {
  const tls = config.tls;
  const skipVerify = tls?.skipVerify || config.tlsSkipVerify;

  // No TLS customization needed
  if (!skipVerify && !tls?.caCert && !tls?.clientCert) return undefined;

  const opts: AgentOptions = {};

  if (skipVerify) {
    opts.rejectUnauthorized = false;
  }

  if (tls?.caCert) {
    opts.ca = readFileSync(tls.caCert);
  }

  if (tls?.clientCert && tls?.clientKey) {
    opts.cert = readFileSync(tls.clientCert);
    opts.key = readFileSync(tls.clientKey);
  }

  return new Agent(opts);
}
