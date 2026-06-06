// Plugin lifecycle hooks — interpose on every tool / resource /
// prompt invocation the gateway dispatches. Plugins declare hooks in
// their manifest; the HookRegistry resolves them on load and the
// dispatcher fires them around each call.
//
// Hooks land here as part of Phase F7 so Phase F9 (virtual servers)
// and Phase F10 (federation) can interpose without duplicating
// dispatch logic.

/** Stable identifier for each hook point. Mirrors the canonical set
 *  the rest of the MCP ecosystem expects to see; extending this is
 *  a breaking change for the plugin contract. */
export type HookKind =
  | "tool_pre_invoke"
  | "tool_post_invoke"
  | "resource_pre_fetch"
  | "resource_post_fetch"
  | "prompt_pre_fetch"
  | "prompt_post_fetch";

/** Hook-time context. Mirrors the RequestContext the gateway already
 *  carries but is intentionally a flat shape so plugins don't take a
 *  dependency on server internals. */
export interface HookContext {
  /** Principal sub identifier (anonymous, OIDC sub, or local user). */
  principal: string;
  /** Tenant the principal is acting under. Always set; "default"
   *  when no tenancy is configured. */
  tenant: string;
  /** Hook fan-out kind. */
  kind: HookKind;
  /** Per-call metadata. Currently: tool name (for tool_*), resource
   *  URI (for resource_*), prompt name (for prompt_*). */
  target: string;
  /** Free-form labels — used by audit + by the hook itself to
   *  cooperate with siblings (e.g. correlation ids). */
  labels?: Record<string, string>;
}

/** Hook-time payload. The exact shape depends on the hook kind:
 *  - tool_pre_invoke: { args: unknown }
 *  - tool_post_invoke: { args: unknown, result: unknown }
 *  - resource_pre_fetch: { uri: string }
 *  - resource_post_fetch: { uri: string, contents: unknown }
 *  - prompt_pre_fetch: { name: string, arguments: unknown }
 *  - prompt_post_fetch: { name: string, arguments: unknown, messages: unknown }
 *
 *  Plugins may mutate the payload — the gateway forwards the mutated
 *  value to the next hook, then to the underlying handler / caller. */
export type HookPayload = Record<string, unknown>;

/** Hook result. `allow=false` short-circuits the dispatch with
 *  `reason` surfaced to the caller. `payload` (when present) replaces
 *  the current payload — used for redaction / transformation /
 *  enrichment. */
export interface HookResult {
  allow: boolean;
  payload?: HookPayload;
  reason?: string;
}

/** A single hook registration. The plugin manifest carries one of
 *  these per hook entry; the loader instantiates the function from
 *  the plugin's source. */
export interface HookRegistration {
  pluginName: string;
  kind: HookKind;
  /** Lower number runs earlier. Default 100 (mid-range). */
  priority?: number;
  /** enforce: blocking errors short-circuit. permissive: errors are
   *  logged and the chain continues with the prior payload.
   *  disabled: hook is loaded but not invoked (emergency disable). */
  mode?: "enforce" | "permissive" | "disabled";
  handler: (ctx: HookContext, payload: HookPayload) => Promise<HookResult> | HookResult;
}

/** Mutable, in-process registry. Plugin loaders push entries here;
 *  the dispatcher reads `fire()` per call.
 *
 *  Hot-swap-safe: a re-registration with the same (pluginName, kind)
 *  replaces the prior entry — used by /api/connectors/install for
 *  zero-downtime hook updates. */
export class HookRegistry {
  private entries: HookRegistration[] = [];

  /** Register or replace a hook entry. Returns the resolved registration. */
  register(entry: HookRegistration): HookRegistration {
    this.entries = this.entries.filter(
      (e) => !(e.pluginName === entry.pluginName && e.kind === entry.kind),
    );
    this.entries.push({
      ...entry,
      priority: entry.priority ?? 100,
      mode: entry.mode ?? "enforce",
    });
    return entry;
  }

  /** Remove all entries owned by a plugin (e.g. on uninstall). */
  unregisterPlugin(pluginName: string): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.pluginName !== pluginName);
    return before - this.entries.length;
  }

  /** All entries for a hook kind in priority order. */
  list(kind: HookKind): HookRegistration[] {
    return this.entries
      .filter((e) => e.kind === kind && e.mode !== "disabled")
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  }

  /** Snapshot of every registration regardless of kind (for diagnostics). */
  all(): HookRegistration[] {
    return [...this.entries];
  }

  /** Fire every hook of the given kind in priority order. Each hook
   *  receives the (possibly mutated) payload from the previous one.
   *  Short-circuits on first `allow:false`. */
  async fire(
    kind: HookKind,
    ctx: HookContext,
    initialPayload: HookPayload,
    logger: (level: "warn" | "info", msg: string) => void = (l, m) =>
      console[l === "warn" ? "warn" : "log"](m),
  ): Promise<HookResult> {
    let payload = initialPayload;
    for (const entry of this.list(kind)) {
      try {
        const r = await entry.handler({ ...ctx, kind }, payload);
        if (!r.allow) {
          return r;
        }
        if (r.payload) payload = r.payload;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (entry.mode === "permissive") {
          logger("warn", `hook ${entry.pluginName}/${kind} threw (permissive): ${msg}`);
          continue;
        }
        // enforce: block the call.
        return {
          allow: false,
          reason: `hook ${entry.pluginName}/${kind} failed: ${msg}`,
        };
      }
    }
    return { allow: true, payload };
  }
}
