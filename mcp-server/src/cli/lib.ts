// Pure, IO-free helpers for the omcp CLI so they can be unit-tested
// without spawning docker or touching the filesystem.

export interface ParsedArgs {
  command: string;
  sub?: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

/** Minimal argv parser: `omcp <command> [sub] [positionals] [--flag[=val]] [-f val]`. */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else if (a.startsWith("-") && a.length > 1) {
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) flags[a.slice(1)] = argv[++i];
      else flags[a.slice(1)] = true;
    } else {
      rest.push(a);
    }
  }
  return { command: rest[0] ?? "", sub: rest[1], flags, positionals: rest.slice(2) };
}

/**
 * Given a desired port and a predicate that says whether a port is in
 * use, return the first free port at or after `desired` (bounded scan).
 */
export function pickFreePort(
  desired: number,
  inUse: (p: number) => boolean,
  span = 50
): number {
  for (let p = desired; p < desired + span; p++) {
    if (!inUse(p)) return p;
  }
  throw new Error(`no free port in [${desired}, ${desired + span})`);
}

/**
 * Build a docker-compose override that remaps the host side of the
 * given service ports. Uses the `!override` tag so it replaces (not
 * appends to) the base `ports:` list.
 */
export function composeOverride(
  remaps: Array<{ service: string; host: number; container: number }>
): string {
  const services = remaps
    .map(
      (r) =>
        `  ${r.service}:\n    ports: !override\n      - "${r.host}:${r.container}"`
    )
    .join("\n");
  return `services:\n${services}\n`;
}

export const HELP = `omcp — observability-mcp control CLI

Usage:
  omcp version                 Print CLI + server package version
  omcp doctor                  Check the local toolchain (docker, compose, helm, node)
  omcp demo up                 Start the full demo stack (auto-picks free host ports)
  omcp demo down               Stop and remove the demo stack
  omcp demo status             Show demo container status
  omcp help                    Show this help

Flags:
  --json                       Machine-readable output (doctor, status)
`;
