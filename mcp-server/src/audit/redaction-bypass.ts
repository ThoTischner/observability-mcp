/**
 * Pure helpers for the redaction-bypass forensic trail.
 *
 * The bypass surface deliberately writes to TWO channels:
 *
 *   1. A sanitised stderr breadcrumb — for SIEM tail-and-forward
 *      setups that ingest the container's stdio. It carries the
 *      correlationId so an investigator can join it with the
 *      tamper-evident chain entry, but it intentionally does NOT
 *      include the credential name / token / actor sub — those would
 *      land in unstructured operator logs that CodeQL flags as a
 *      taint sink.
 *
 *   2. The management-plane audit chain — full identity (actor.sub +
 *      tenant), hashed alongside every other mutating /api/* call.
 *      Survives a process restart when OMCP_MGMT_AUDIT_FILE is set;
 *      otherwise lives in the 500-entry in-memory ring.
 *
 * The bypass code path is small but security-critical: a regression
 * that drops either channel weakens the audit story. The pure
 * helpers below let unit tests pin the shape of both records, plus
 * the boundary properties:
 *
 *   - resource === "redaction", action === "bypass" (RBAC vocabulary)
 *   - status === 200 on engage, 403 on deny
 *   - stderr breadcrumb omits anything credential-shaped
 *   - target === args.service (when present)
 */

import type { RequestContext } from "../context.js";

export type BypassEvent = "redaction_bypass_engaged" | "redaction_bypass_denied";

/** Stderr-breadcrumb payload. JSON-serialised by the caller. */
export interface BypassBreadcrumb {
  event: BypassEvent;
  ts: string;
  auth: RequestContext["auth"];
  tool: string;
  service: string | null;
  correlationId: string;
  /** Only populated on the deny branch — explains why the request
   *  was rejected, never carries the credential name itself. */
  reason?: "credential_not_in_OMCP_KEY_BYPASS_REDACTION";
}

export interface BypassAuditParams {
  actor: { sub: string };
  tenant: string;
  resource: "redaction";
  action: "bypass";
  method: "MCP";
  path: string;
  status: 200 | 403;
  target?: string;
}

/** Shape the stderr breadcrumb. Deliberately credential-free; the
 *  joining key to the audit chain is the correlationId. */
export function buildBypassBreadcrumb(
  event: BypassEvent,
  ctx: RequestContext,
  args: unknown,
  opts: { tool?: string; nowIso?: string } = {},
): BypassBreadcrumb {
  const out: BypassBreadcrumb = {
    event,
    ts: opts.nowIso ?? new Date().toISOString(),
    auth: ctx.auth,
    tool: opts.tool ?? "query_logs",
    service: (args as { service?: string })?.service ?? null,
    correlationId: ctx.correlationId,
  };
  if (event === "redaction_bypass_denied") {
    out.reason = "credential_not_in_OMCP_KEY_BYPASS_REDACTION";
  }
  return out;
}

/** Shape the management-plane audit record. Engaged = 200 (the
 *  bypass actually fired), denied = 403 (the agent asked but the
 *  credential wasn't allow-listed). Either way the chain captures
 *  the attempt. */
export function buildBypassAuditParams(
  engaged: boolean,
  ctx: RequestContext,
  args: unknown,
  opts: { tool?: string } = {},
): BypassAuditParams {
  const tool = opts.tool ?? "query_logs";
  const params: BypassAuditParams = {
    actor: { sub: ctx.principalId },
    tenant: ctx.tenant,
    resource: "redaction",
    action: "bypass",
    method: "MCP",
    path: `/mcp/${tool}`,
    status: engaged ? 200 : 403,
  };
  const service = (args as { service?: string })?.service;
  if (typeof service === "string" && service) params.target = service;
  return params;
}
