// Inspect — the observe recorder.
//
// Registers as a `tool_post_invoke` hook in PERMISSIVE mode so it can never
// block a tool call (and even if it threw, the hook registry swallows it for a
// permissive hook). It redacts the args, derives a signature, and appends one
// observation. Pure side-effect; returns allow:true always.

import type { HookContext, HookPayload, HookRegistration, HookResult } from "../sdk/hooks.js";
import { redactValue } from "../policy/redact.js";
import { deriveSignature } from "./signature.js";
import type { Decision, InspectStore, Outcome } from "./store.js";
import type { ModeController } from "./mode.js";

/** An MCP tool result signals failure via `isError: true`. */
export function isErrorResult(result: unknown): boolean {
  return !!(result && typeof result === "object" && (result as { isError?: unknown }).isError === true);
}

/** Coarse auth-kind inference from the principal (HookContext has no auth). */
export function authKind(principal: string): string {
  return principal === "anonymous" ? "anonymous" : "apikey";
}

export interface RecorderOptions {
  /** Metrics seam — called once per recorded observation. */
  onEvent?: (e: { tool: string; outcome: Outcome; decision: Decision }) => void;
}

/**
 * Build the observe-mode recorder hook. Records every tool call as an
 * allow-observation when the mode is recording (anything but `off`).
 * Dry-run/enforce decisioning is a separate pre-invoke hook (added later);
 * this one only ever records `decision: "allow"`.
 */
export function createInspectRecorder(
  store: InspectStore,
  mode: ModeController,
  opts: RecorderOptions = {},
): HookRegistration {
  const handler = (ctx: HookContext, payload: HookPayload): HookResult => {
    try {
      if (!mode.recording) return { allow: true };
      const red = redactValue((payload as { args?: unknown }).args);
      const sig = deriveSignature(ctx.target, red.value);
      const outcome: Outcome = isErrorResult((payload as { result?: unknown }).result) ? "error" : "ok";
      store.record({
        principal: ctx.principal,
        auth: authKind(ctx.principal),
        tenant: ctx.tenant,
        tool: ctx.target,
        source: sig.source,
        service: sig.service,
        namespace: sig.namespace,
        argShape: sig.argShape,
        outcome,
        decision: "allow",
        redactions: red.totalMatches,
      });
      opts.onEvent?.({ tool: ctx.target, outcome, decision: "allow" });
    } catch {
      // Observation must never affect the call path.
    }
    return { allow: true };
  };

  return {
    pluginName: "inspect-recorder",
    kind: "tool_post_invoke",
    priority: 5,
    mode: "permissive",
    handler,
  };
}
