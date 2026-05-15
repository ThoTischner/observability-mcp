import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  pickFreePort,
  composeOverride,
  resolveCatalogSource,
  formatPluginList,
  formatPluginInfo,
  DEFAULT_CATALOG_URL,
  type Catalog,
} from "./lib.js";

const CAT: Catalog = {
  catalogVersion: 1,
  connectors: [
    {
      name: "prometheus",
      displayName: "Prometheus",
      description: "PromQL metrics.",
      tier: "official",
      builtin: true,
      signalTypes: ["metrics"],
      latest: "1.4.0",
      versions: [{ version: "1.4.0", releasedAt: "2026-05-15", serverCompat: ">=1.4.0" }],
    },
    {
      name: "tempo",
      displayName: "Grafana Tempo",
      description: "TraceQL.",
      tier: "third-party",
      signalTypes: ["traces"],
      versions: [
        { version: "1.0.0", releasedAt: "2026-05-15", integrity: "sha256-AAAA=", signatureUrl: "https://x/s.sig" },
      ],
    },
  ],
};

test("parseArgs: command, sub, positionals", () => {
  const p = parseArgs(["demo", "up", "extra"]);
  assert.equal(p.command, "demo");
  assert.equal(p.sub, "up");
  assert.deepEqual(p.positionals, ["extra"]);
});

test("parseArgs: --flag=val, --flag val, boolean, -f val", () => {
  const p = parseArgs(["plugin", "install", "loki", "--from=/m", "--ver", "1.2.0", "--json", "-f", "x"]);
  assert.equal(p.command, "plugin");
  assert.equal(p.sub, "install");
  assert.deepEqual(p.positionals, ["loki"]);
  assert.equal(p.flags.from, "/m");
  assert.equal(p.flags.ver, "1.2.0");
  assert.equal(p.flags.json, true);
  assert.equal(p.flags.f, "x");
});

test("parseArgs: empty argv", () => {
  const p = parseArgs([]);
  assert.equal(p.command, "");
  assert.equal(p.sub, undefined);
});

test("pickFreePort returns desired when free", () => {
  assert.equal(pickFreePort(3000, () => false), 3000);
});

test("pickFreePort skips used ports", () => {
  const used = new Set([3000, 3001, 3002]);
  assert.equal(pickFreePort(3000, (p) => used.has(p)), 3003);
});

test("pickFreePort throws when span exhausted", () => {
  assert.throws(() => pickFreePort(3000, () => true, 5), /no free port/);
});

test("composeOverride emits !override port mappings", () => {
  const y = composeOverride([
    { service: "mcp-server", host: 3001, container: 3000 },
    { service: "loki", host: 3101, container: 3100 },
  ]);
  assert.match(y, /^services:\n/);
  assert.match(y, /  mcp-server:\n    ports: !override\n      - "3001:3000"/);
  assert.match(y, /  loki:\n    ports: !override\n      - "3101:3100"/);
});

test("resolveCatalogSource: explicit url, explicit path, local, default", () => {
  assert.deepEqual(resolveCatalogSource("https://h/x.json", null), { kind: "url", location: "https://h/x.json" });
  assert.deepEqual(resolveCatalogSource("/tmp/c.json", null), { kind: "file", location: "/tmp/c.json" });
  assert.deepEqual(resolveCatalogSource(undefined, "/repo/hub/catalog/index.json"), { kind: "file", location: "/repo/hub/catalog/index.json" });
  assert.deepEqual(resolveCatalogSource(undefined, null), { kind: "url", location: DEFAULT_CATALOG_URL });
});

test("formatPluginList: header, sorted rows, builtin+tier flags", () => {
  const out = formatPluginList(CAT);
  const lines = out.split("\n");
  assert.match(lines[0], /^NAME\s+LATEST\s+SIGNALS\s+TIER$/);
  // sorted: prometheus before tempo
  assert.ok(lines[1].startsWith("prometheus"));
  assert.match(lines[1], /builtin,official/);
  assert.ok(lines[2].startsWith("tempo"));
  assert.match(lines[2], /third-party/);
});

test("formatPluginInfo: versions + integrity/signature surfaced", () => {
  const info = formatPluginInfo(CAT.connectors[1]);
  assert.match(info, /Grafana Tempo {2}\(tempo\)/);
  assert.match(info, /tier: {6}third-party/);
  assert.match(info, /1\.0\.0 \(2026-05-15\)/);
  assert.match(info, /integrity: sha256-AAAA=/);
  assert.match(info, /signature: https:\/\/x\/s\.sig/);
});

import { parsePluginRef, resolveInstall } from "./lib.js";

test("parsePluginRef: name and name@version, rejects junk", () => {
  assert.deepEqual(parsePluginRef("tempo"), { name: "tempo", version: undefined });
  assert.deepEqual(parsePluginRef("tempo@1.2.3"), { name: "tempo", version: "1.2.3" });
  assert.deepEqual(parsePluginRef("x@1.0.0-rc.1"), { name: "x", version: "1.0.0-rc.1" });
  assert.throws(() => parsePluginRef("Bad Name"), /invalid plugin ref/);
  assert.throws(() => parsePluginRef("tempo@v1"), /invalid plugin ref/);
});

test("resolveInstall: builtin short-circuits", () => {
  const r = resolveInstall(CAT, "prometheus");
  assert.equal(r.builtin, true);
  assert.equal(r.name, "prometheus");
});

test("resolveInstall: picks latest then specific version", () => {
  const def = resolveInstall(CAT, "tempo");
  assert.equal(def.version, "1.0.0");
  assert.equal(def.builtin, false);
  assert.equal(def.integrity, "sha256-AAAA=");
  const pinned = resolveInstall(CAT, "tempo@1.0.0");
  assert.equal(pinned.version, "1.0.0");
  assert.throws(() => resolveInstall(CAT, "tempo@9.9.9"), /not found/);
  assert.throws(() => resolveInstall(CAT, "ghost"), /no connector/);
});

import { splitPassthrough, helmReleaseArgs, HELM_CHART } from "./lib.js";

test("splitPassthrough: splits at first -- ", () => {
  assert.deepEqual(splitPassthrough(["helm", "install", "obs"]), {
    argv: ["helm", "install", "obs"],
    passthrough: [],
  });
  assert.deepEqual(
    splitPassthrough(["helm", "upgrade", "obs", "--", "-n", "mon", "--set", "a=b"]),
    { argv: ["helm", "upgrade", "obs"], passthrough: ["-n", "mon", "--set", "a=b"] }
  );
});

test("helmReleaseArgs: install vs upgrade --install, passthrough appended", () => {
  assert.deepEqual(helmReleaseArgs("install", "obs", []), ["install", "obs", HELM_CHART]);
  assert.deepEqual(helmReleaseArgs("upgrade", "obs", ["-n", "mon"]), [
    "upgrade",
    "--install",
    "obs",
    HELM_CHART,
    "-n",
    "mon",
  ]);
});
