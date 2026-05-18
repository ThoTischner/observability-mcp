// Enterprise gate — the OPTIONAL seam that lets a deployment activate the
// source-available enterprise/ modules (RBAC, Catalog, Audit) behind a
// signed entitlement token.
//
// Hard rules this file obeys, so the Apache-2.0 core stays clean:
//
//   1. NO static import of anything under enterprise/. The modules are
//      loaded with a dynamic import() of a computed specifier, so the
//      Apache build never references FSL code.
//   2. DEFAULT-OFF and fail-safe. With no entitlement token configured —
//      the only state the published npm/Docker artifact can be in, since
//      enterprise/ is excluded from both — `enforceEntitledAccess` is an
//      awaited no-op and behaviour is byte-for-byte unchanged.
//   3. enterprise/ is a sibling of mcp-server/. It is absent from the
//      published artifact; a failed dynamic import must therefore leave
//      the gate cleanly OFF, never crash.
//
// Activation (only when an operator opts in, from a full checkout that
// still contains enterprise/):
//
//   OMCP_ENTITLEMENT_TOKEN   signed token  "<b64url payload>.<b64url sig>"
//   OMCP_ENTITLEMENT_PUBKEY  Ed25519 public key — PEM literal, or @<path>
//   OMCP_RBAC_POLICY         optional path to an RBAC policy JSON
//   OMCP_CATALOG             optional path to a product-catalog JSON
//
// Feature gating: the token's `features` must include "access-control"
// for RBAC/Catalog enforcement and "audit" for the audit log. If a
// policy/catalog file is configured but the token does not entitle
// "access-control", access is denied (fail-closed — a configured control
// must never be silently disabled).

import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { RequestContext } from "./context.js";

// enterprise/ relative to this file (src/ at dev, dist/ at runtime) — in
// both layouts ../../enterprise resolves to the repo-level directory.
const HERE = dirname(fileURLToPath(import.meta.url));
const ENTERPRISE_DIR = resolve(HERE, "..", "..", "enterprise");

export interface ToolRequest {
  tool: string;
  source?: string;
  service?: string;
}

// Three modes, not two — this distinction is the whole security story:
//
//   off          no controls configured AND no entitlement → pure
//                 pass-through. The ONLY state the published artifact
//                 can reach (enterprise/ is excluded from it).
//   fail-closed  the operator CONFIGURED a control (OMCP_RBAC_POLICY /
//                 OMCP_CATALOG) but the gate could not be activated
//                 (missing/invalid/expired token, or modules absent).
//                 A broken entitlement must DENY, never silently open.
//   active       valid entitlement + controls → enforce normally.
type GateState =
  | { mode: "off" }
  | { mode: "fail-closed"; reason: string }
  | {
      mode: "active";
      claims: Record<string, unknown>;
      accessControl: boolean;
      enforceRbac?: (policy: unknown, ctx: unknown, req: unknown) => unknown;
      enforceCatalog?: (catalog: unknown, ctx: unknown, req: unknown) => unknown;
      rbacPolicy?: unknown;
      catalog?: unknown;
      audit?: { record: (e: unknown) => Promise<unknown> };
    };

/** Did the operator opt into any enterprise control? */
function controlsConfigured(): boolean {
  return !!(process.env.OMCP_RBAC_POLICY || process.env.OMCP_CATALOG);
}

/** Map an inability-to-activate into off (no opt-in) or fail-closed. */
function inactive(reason: string): GateState {
  return controlsConfigured() ? { mode: "fail-closed", reason } : { mode: "off" };
}

let gatePromise: Promise<GateState> | null = null;

function readPubKey(spec: string): string {
  if (spec.startsWith("@")) return readFileSync(spec.slice(1), "utf8");
  return spec.replace(/\\n/g, "\n");
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

async function buildGate(): Promise<GateState> {
  const token = process.env.OMCP_ENTITLEMENT_TOKEN;
  const pub = process.env.OMCP_ENTITLEMENT_PUBKEY;
  if (!token || !pub) {
    return inactive("no entitlement token configured");
  }

  // Dynamic, dependency-free import. If enterprise/ is absent (the
  // published artifact) this throws → no opt-in means OFF; a configured
  // control with absent modules means FAIL-CLOSED.
  let entitlementMod: any;
  try {
    entitlementMod = await import(join(ENTERPRISE_DIR, "entitlement", "index.mjs"));
  } catch {
    return inactive("enterprise/ modules not present");
  }

  let claims: Record<string, unknown>;
  try {
    const res = entitlementMod.verifyEntitlement(token, readPubKey(pub));
    if (!res.valid) return inactive(`entitlement invalid: ${res.reason}`);
    claims = res.claims;
  } catch (e) {
    return inactive(`entitlement verification error: ${String(e)}`);
  }

  const has = (f: string) => entitlementMod.hasFeature(claims, f);
  const state: Extract<GateState, { mode: "active" }> = {
    mode: "active",
    claims,
    accessControl: has("access-control"),
  };

  // Audit (best-effort; only if entitled and the module loads).
  if (has("audit")) {
    try {
      const auditMod: any = await import(join(ENTERPRISE_DIR, "audit", "index.mjs"));
      const auditFile = process.env.OMCP_AUDIT_FILE;
      const sink = auditFile
        ? (entry: unknown) => appendFileSync(resolve(auditFile), JSON.stringify(entry) + "\n")
        : undefined;
      state.audit = auditMod.createAuditLog({ sink });
    } catch {
      /* audit is best-effort; absence must not break enforcement */
    }
  }

  // RBAC / Catalog enforcers + their operator-supplied config.
  if (process.env.OMCP_RBAC_POLICY) {
    const rbacMod: any = await import(join(ENTERPRISE_DIR, "rbac", "index.mjs"));
    state.enforceRbac = rbacMod.enforce;
    state.rbacPolicy = readJsonFile(process.env.OMCP_RBAC_POLICY);
  }
  if (process.env.OMCP_CATALOG) {
    const catMod: any = await import(join(ENTERPRISE_DIR, "catalog", "index.mjs"));
    state.enforceCatalog = catMod.enforceCatalog;
    state.catalog = readJsonFile(process.env.OMCP_CATALOG);
  }

  return state;
}

/** Reset memoised state (tests only). */
export function _resetEnterpriseGate(): void {
  gatePromise = null;
}

/** Gate mode — for diagnostics (/api/info). */
export async function enterpriseGateStatus(): Promise<{
  active: boolean;
  mode: GateState["mode"];
  reason?: string;
}> {
  if (!gatePromise) gatePromise = buildGate();
  const g = await gatePromise;
  if (g.mode === "active") return { active: true, mode: "active" };
  if (g.mode === "fail-closed") return { active: false, mode: "fail-closed", reason: g.reason };
  return { active: false, mode: "off" };
}

/**
 * The single enforcement point, called before every MCP tool runs.
 *
 * off:         no opt-in, no entitlement → memoised no-op, returns
 *               immediately. Zero behaviour change for the OSS core;
 *               the only path the published artifact ever takes.
 * fail-closed:  a control was configured but the gate could not be
 *               activated → deny EVERY tool call (a broken/expired
 *               entitlement must never silently disable enforcement).
 * active:       record the decision (if audit entitled) and deny by
 *               throwing — the MCP SDK turns the throw into a clean tool
 *               error and the handler never runs.
 */
export async function enforceEntitledAccess(
  ctx: RequestContext,
  request: ToolRequest
): Promise<void> {
  if (!gatePromise) gatePromise = buildGate();
  const g = await gatePromise;
  if (g.mode === "off") return; // ← the only path the published artifact takes
  if (g.mode === "fail-closed") {
    throw new Error(`access denied: enterprise control configured but inactive (${g.reason})`);
  }

  const decide = (): { allow: boolean; reason: string } => {
    // A configured control with no "access-control" entitlement is a
    // misconfiguration we fail CLOSED on, never silently open.
    const controlConfigured = !!(g.enforceRbac || g.enforceCatalog);
    if (controlConfigured && !g.accessControl) {
      return { allow: false, reason: "access-control not entitled by token" };
    }
    try {
      if (g.enforceRbac) g.enforceRbac(g.rbacPolicy, ctx, request);
      if (g.enforceCatalog) g.enforceCatalog(g.catalog, ctx, request);
      return { allow: true, reason: "entitled" };
    } catch (e: any) {
      return { allow: false, reason: e?.reason || e?.message || "denied" };
    }
  };

  const decision = decide();

  if (g.audit) {
    try {
      await g.audit.record({
        kind: "access-decision",
        principalId: ctx.principalId,
        auth: ctx.auth,
        correlationId: ctx.correlationId,
        request,
        allow: decision.allow,
        reason: decision.reason,
      });
    } catch {
      /* audit failure must not change the access outcome */
    }
  }

  if (!decision.allow) {
    throw new Error(`access denied: ${decision.reason}`);
  }
}
