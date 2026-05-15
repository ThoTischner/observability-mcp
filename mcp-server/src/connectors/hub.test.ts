import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveHubCatalogUrl,
  describeInstalled,
  mergeCatalog,
  fetchHubCatalog,
  DEFAULT_HUB_CATALOG_URL,
} from "./hub.js";
import type { LoadedConnector } from "./loader.js";

test("resolveHubCatalogUrl: default + env override", () => {
  assert.equal(resolveHubCatalogUrl({}), DEFAULT_HUB_CATALOG_URL);
  assert.equal(
    resolveHubCatalogUrl({ HUB_CATALOG_URL: "http://mirror/idx.json" }),
    "http://mirror/idx.json"
  );
});

test("describeInstalled maps loader entries, sorts, defaults", () => {
  const loaded = [
    { name: "loki", source: "builtin", factory: () => ({}) },
    {
      name: "datadog",
      source: "filesystem",
      factory: () => ({}),
      manifest: {
        displayName: "Datadog",
        description: "DD",
        version: "1.0.0",
        signalTypes: ["metrics", "logs"],
        capabilities: { queryMetrics: true },
      },
    },
  ] as unknown as LoadedConnector[];
  const d = describeInstalled(loaded);
  assert.deepEqual(d.map((x) => x.name), ["datadog", "loki"]); // sorted
  assert.equal(d[0].displayName, "Datadog");
  assert.deepEqual(d[0].signalTypes, ["metrics", "logs"]);
  assert.equal(d[1].displayName, "loki"); // falls back to name
  assert.equal(d[1].version, null);
  assert.deepEqual(d[1].capabilities, {});
});

test("mergeCatalog marks installed + version, sorts, tolerates null", () => {
  const installed = describeInstalled([
    { name: "datadog", source: "filesystem", factory: () => ({}), manifest: { version: "1.0.0" } },
  ] as unknown as LoadedConnector[]);
  const merged = mergeCatalog(
    { connectors: [
      { name: "grafana", displayName: "Grafana", description: "", tier: "official", signalTypes: ["metrics"], versions: [{ version: "1.0.0" }] },
      { name: "datadog", displayName: "Datadog", description: "", tier: "official", signalTypes: ["metrics"], versions: [{ version: "1.0.0" }] },
    ] },
    installed
  );
  assert.deepEqual(merged.map((m) => m.name), ["datadog", "grafana"]);
  assert.equal(merged[0].installed, true);
  assert.equal(merged[0].installedVersion, "1.0.0");
  assert.equal(merged[1].installed, false);
  assert.deepEqual(mergeCatalog(null, installed), []);
});

test("fetchHubCatalog: ok, http error, malformed", async () => {
  const ok = async () => ({ ok: true, status: 200, json: async () => ({ connectors: [{ name: "x" }], catalogVersion: 1 }) }) as Response;
  const r = await fetchHubCatalog("u", ok as unknown as typeof fetch);
  assert.equal(r.connectors.length, 1);
  await assert.rejects(
    () => fetchHubCatalog("u", (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch),
    /HTTP 503/
  );
  await assert.rejects(
    () => fetchHubCatalog("u", (async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch),
    /malformed/
  );
});
