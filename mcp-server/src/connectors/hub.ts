// Connector-hub integration helpers (pure, IO-injectable so they unit
// test without network). Powers the Web UI "Connectors" page:
//   - what's installed/loaded right now
//   - what the hub catalog offers, with an "installed" marker

import type { LoadedConnector } from "./loader.js";

export const DEFAULT_HUB_CATALOG_URL =
  "https://thotischner.github.io/observability-mcp/hub/index.json";

/** Catalog source: env override wins (airgapped mirror / private hub). */
export function resolveHubCatalogUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.HUB_CATALOG_URL || DEFAULT_HUB_CATALOG_URL;
}

export interface InstalledConnector {
  name: string;
  source: "builtin" | "filesystem" | "config";
  displayName: string;
  description: string;
  version: string | null;
  signalTypes: string[];
  capabilities: Record<string, boolean>;
}

/** Shape the loader's entries into the UI's installed list. */
export function describeInstalled(loaded: LoadedConnector[]): InstalledConnector[] {
  return loaded
    .map((p) => ({
      name: p.name,
      source: p.source,
      displayName: p.manifest?.displayName ?? p.name,
      description: p.manifest?.description ?? "",
      version: p.manifest?.version ?? null,
      signalTypes: p.manifest?.signalTypes ?? [],
      capabilities: (p.manifest?.capabilities as Record<string, boolean>) ?? {},
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface CatalogConnector {
  name: string;
  displayName: string;
  description: string;
  tier: string;
  builtin?: boolean;
  signalTypes: string[];
  latest?: string;
  versions: Array<{ version: string; tarballUrl?: string; integrity?: string; serverCompat?: string; changelog?: string; releasedAt?: string }>;
}

export interface HubCatalogEntry extends CatalogConnector {
  installed: boolean;
  installedVersion: string | null;
}

/**
 * Merge the hub catalog with what's installed so the UI can show
 * status + offer not-yet-installed connectors.
 */
export function mergeCatalog(
  catalog: { connectors?: CatalogConnector[] } | null,
  installed: InstalledConnector[]
): HubCatalogEntry[] {
  const byName = new Map(installed.map((i) => [i.name, i]));
  return (catalog?.connectors ?? [])
    .map((c) => {
      const have = byName.get(c.name);
      return {
        ...c,
        installed: !!have,
        installedVersion: have?.version ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Fetch + parse the catalog. fetchImpl injected for tests. */
export async function fetchHubCatalog(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ connectors: CatalogConnector[]; catalogVersion?: number }> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`hub catalog HTTP ${res.status} from ${url}`);
  const body = (await res.json()) as { connectors?: CatalogConnector[]; catalogVersion?: number };
  if (!body || !Array.isArray(body.connectors)) {
    throw new Error("hub catalog malformed (no connectors[])");
  }
  return { connectors: body.connectors, catalogVersion: body.catalogVersion };
}
