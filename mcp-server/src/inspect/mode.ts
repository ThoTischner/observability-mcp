// Inspect — mode state machine.
//
// off → observe → dryrun → enforce. `observe` is the default and is purely a
// recorder (zero decision on the call path). `dryrun` and `enforce` add a
// profile evaluation; only `enforce` ever blocks. The boot default comes from
// OMCP_INSPECT; the mode can be changed at runtime via the API.

export type InspectMode = "off" | "observe" | "dryrun" | "enforce";

export const INSPECT_MODES: readonly InspectMode[] = ["off", "observe", "dryrun", "enforce"];

/** Parse a user/env string into a mode, or null when unrecognised. */
export function parseMode(s: unknown): InspectMode | null {
  if (typeof s !== "string") return null;
  const v = s.trim().toLowerCase();
  // Friendly aliases.
  if (v === "complain") return "dryrun";
  if (v === "dry-run") return "dryrun";
  if (v === "on") return "observe";
  return (INSPECT_MODES as readonly string[]).includes(v) ? (v as InspectMode) : null;
}

/** Resolve the boot mode from an env value, defaulting to `observe`. */
export function bootMode(envValue: unknown): InspectMode {
  return parseMode(envValue) ?? "observe";
}

export class ModeController {
  private mode: InspectMode;
  private readonly onChange?: (m: InspectMode) => void;

  constructor(initial: InspectMode = "observe", onChange?: (m: InspectMode) => void) {
    this.mode = initial;
    this.onChange = onChange;
  }

  get(): InspectMode {
    return this.mode;
  }

  /** Set the mode. Returns the resolved mode; throws on an invalid value. */
  set(next: unknown): InspectMode {
    const m = parseMode(next);
    if (!m) throw new Error(`invalid inspect mode '${String(next)}' (allowed: ${INSPECT_MODES.join(", ")})`);
    this.mode = m;
    this.onChange?.(m);
    return m;
  }

  /** True when the recorder should capture observations. */
  get recording(): boolean {
    return this.mode !== "off";
  }

  /** True when calls should be evaluated against the profile. */
  get evaluating(): boolean {
    return this.mode === "dryrun" || this.mode === "enforce";
  }

  /** True when a deviation should actually be blocked. */
  get blocking(): boolean {
    return this.mode === "enforce";
  }
}
