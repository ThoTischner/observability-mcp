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

export const DEFAULT_CATALOG_URL =
  "https://thotischner.github.io/observability-mcp/hub/index.json";

export interface CatalogVersion {
  version: string;
  releasedAt?: string;
  serverCompat?: string;
  tarballUrl?: string;
  signatureUrl?: string;
  manifestUrl?: string;
  integrity?: string;
  changelog?: string;
}
export interface CatalogConnector {
  name: string;
  displayName: string;
  description: string;
  tier: string;
  builtin?: boolean;
  signalTypes: string[];
  latest?: string;
  versions: CatalogVersion[];
}
export interface Catalog {
  catalogVersion: number;
  connectors: CatalogConnector[];
}

/**
 * Decide where to read the catalog from, in priority order:
 *   1. explicit `from` (a URL or a filesystem path)
 *   2. a local checkout's hub/catalog/index.json (when localPath exists)
 *   3. the public Pages catalog
 */
export function resolveCatalogSource(
  from: string | undefined,
  localPath: string | null
): { kind: "url" | "file"; location: string } {
  if (from) {
    return /^https?:\/\//.test(from)
      ? { kind: "url", location: from }
      : { kind: "file", location: from };
  }
  if (localPath) return { kind: "file", location: localPath };
  return { kind: "url", location: DEFAULT_CATALOG_URL };
}

export function formatPluginList(cat: Catalog): string {
  const rows = cat.connectors
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => {
      const latest = c.latest ?? c.versions[0]?.version ?? "—";
      const flags = [c.builtin ? "builtin" : "", c.tier].filter(Boolean).join(",");
      return [c.name, latest, c.signalTypes.join("+"), flags];
    });
  const head = ["NAME", "LATEST", "SIGNALS", "TIER"];
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  );
  const line = (cols: string[]) =>
    cols.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(head), ...rows.map(line)].join("\n");
}

export function formatPluginInfo(c: CatalogConnector): string {
  const out: string[] = [];
  out.push(`${c.displayName}  (${c.name})`);
  out.push(`  tier:      ${c.tier}${c.builtin ? " · builtin (ships in the server image)" : ""}`);
  out.push(`  signals:   ${c.signalTypes.join(", ")}`);
  out.push(`  ${c.description}`);
  out.push(`  versions:`);
  for (const v of c.versions) {
    out.push(`    - ${v.version}${v.releasedAt ? ` (${v.releasedAt})` : ""}${v.serverCompat ? ` · server ${v.serverCompat}` : ""}`);
    if (v.integrity) out.push(`      integrity: ${v.integrity}`);
    if (v.signatureUrl) out.push(`      signature: ${v.signatureUrl}`);
    if (v.tarballUrl) out.push(`      tarball:   ${v.tarballUrl}`);
    if (v.changelog) out.push(`      changelog: ${v.changelog}`);
  }
  return out.join("\n");
}

/** Split "name" or "name@1.2.3" into parts. Throws on a malformed ref. */
export function parsePluginRef(ref: string): { name: string; version?: string } {
  const m = ref.match(/^([a-z][a-z0-9-]*)(?:@(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?))?$/);
  if (!m) throw new Error(`invalid plugin ref '${ref}' (expected name or name@x.y.z)`);
  return { name: m[1], version: m[2] };
}

export interface ResolvedInstall {
  name: string;
  version: string;
  builtin: boolean;
  tarballUrl?: string;
  signatureUrl?: string;
  manifestUrl?: string;
  integrity?: string;
}

/**
 * Resolve a catalog + ref into the concrete artifact to install.
 * Returns {builtin:true} for image-bundled connectors (caller should
 * no-op). Throws if the connector/version is unknown.
 */
export function resolveInstall(cat: Catalog, ref: string): ResolvedInstall {
  const { name, version } = parsePluginRef(ref);
  const c = cat.connectors.find((x) => x.name === name);
  if (!c) throw new Error(`no connector '${name}' in catalog (try: omcp plugin list)`);
  if (c.builtin) return { name, version: version ?? c.latest ?? "", builtin: true };
  const v = version
    ? c.versions.find((x) => x.version === version)
    : c.versions.find((x) => x.version === (c.latest ?? c.versions[0]?.version)) ?? c.versions[0];
  if (!v) throw new Error(`version '${version}' not found for '${name}'`);
  return {
    name,
    version: v.version,
    builtin: false,
    tarballUrl: v.tarballUrl,
    signatureUrl: v.signatureUrl,
    manifestUrl: v.manifestUrl,
    integrity: v.integrity,
  };
}

export const HELP = `omcp — observability-mcp control CLI

Usage:
  omcp version                 Print CLI + server package version
  omcp doctor                  Check the local toolchain (docker, compose, helm, node)
  omcp demo up                 Start the full demo stack (auto-picks free host ports)
  omcp demo down               Stop and remove the demo stack
  omcp demo status             Show demo container status
  omcp plugin list             List connectors from the hub catalog
  omcp plugin info <name>      Show one connector's versions + verification info
  omcp plugin install <ref>    Install name[@version]: download, verify, extract
  omcp help                    Show this help

Flags:
  --json                       Machine-readable output (doctor, status, plugin)
  --from <url|path>            Catalog source (default: local checkout or the public hub)
  --offline-dir <dir>          Airgapped: read <name>-<ver>.tgz[.sig] + manifest from <dir>
  --trust-root <pem>           Verify signature+integrity against this PEM (fail-closed)
  --insecure                   Skip verification (NOT recommended; explicit opt-out)
  --dest <dir>                 Install target (default: $PLUGINS_DIR or ./plugins)
  --force                      Overwrite an existing install dir
`;
