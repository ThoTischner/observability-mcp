// Inspect — the enforcer.
//
// A `tool_pre_invoke` hook that BLOCKS calls falling outside the accepted
// profile, but ONLY when the mode is `enforce`. In observe/dry-run it is a
// pass-through (dry-run's would-block recording happens in the post-invoke
// recorder). When it blocks, it records a `blocked` observation itself —
// because a pre-invoke denial short-circuits the dispatch, so the post-invoke
// recorder never runs for blocked calls (no double-recording).
//
// Fail-open: any internal error returns allow:true. An inspector bug must
// never become a denial-of-service for the agent's tools.

import type { HookContext, HookPayload, HookRegistration, HookResult } from "../sdk/hooks.js";
import { redactValue } from "../policy/redact.js";
import { deriveSignature } from "./signature.js";
import type { InspectStore } from "./store.js";
import type { ModeController } from "./mode.js";
import { authKind, type ProfileEvaluator } from "./recorder.js";

export interface EnforcerOptions {
  onEvent?: (e: { tool: string; outcome: "ok" | "error"; decision: "blocked" }) => void;
}

/**
 * Build the enforce-mode pre-invoke hook. Blocks (and records) calls outside
 * the accepted profile only when mode is `enforce`; pass-through otherwise.
 */
export function createInspectEnforcer(
  store: InspectStore,
  mode: ModeController,
  evaluator: ProfileEvaluator,
  opts: EnforcerOptions = {},
): HookRegistration {
  const handler = (ctx: HookContext, payload: HookPayload): HookResult => {
    try {
      if (!mode.blocking) return { allow: true };
      const red = redactValue((payload as { args?: unknown }).args);
      const sig = deriveSignature(ctx.target, red.value);
      const ev = evaluator.evaluate({
        principal: ctx.principal, tool: ctx.target,
        source: sig.source, service: sig.service, namespace: sig.namespace,
        argShape: sig.argShape,
      });
      if (ev.verdict === "deviation") {
        store.record({
          principal: ctx.principal,
          auth: authKind(ctx.principal),
          tenant: ctx.tenant,
          tool: ctx.target,
          source: sig.source,
          service: sig.service,
          namespace: sig.namespace,
          argShape: sig.argShape,
          outcome: "error",
          decision: "blocked",
          deviation: ev.kind,
          redactions: red.totalMatches,
        });
        opts.onEvent?.({ tool: ctx.target, outcome: "error", decision: "blocked" });
        return {
          allow: false,
          reason: `Blocked by the inspection profile (${ev.kind ?? "deviation"}). This call falls outside the accepted baseline for ${ctx.principal}; review it under Inspect → Deviations.`,
        };
      }
    } catch {
      // Fail open — an inspector error must never block a tool call.
      return { allow: true };
    }
    return { allow: true };
  };

  return {
    pluginName: "inspect-enforcer",
    kind: "tool_pre_invoke",
    priority: 5,
    mode: "permissive",
    handler,
  };
}
