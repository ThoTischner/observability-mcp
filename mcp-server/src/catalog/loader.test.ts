import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCatalogFile, validateCatalog, CatalogStore } from "./loader.js";

test("readCatalogFile — missing path returns empty catalog", async () => {
  const c = await readCatalogFile(undefined);
  assert.deepEqual(c, { services: {} });
});

test("readCatalogFile — missing file returns empty catalog (no crash)", async () => {
  const c = await readCatalogFile("/tmp/definitely-does-not-exist-omcp.json");
  assert.deepEqual(c, { services: {} });
});

test("readCatalogFile — malformed JSON returns empty catalog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omcp-catalog-"));
  try {
    const file = join(dir, "catalog.json");
    await writeFile(file, "{this is not json", "utf8");
    const c = await readCatalogFile(file);
    assert.deepEqual(c, { services: {} });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readCatalogFile — valid file returns parsed catalog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omcp-catalog-"));
  try {
    const file = join(dir, "catalog.json");
    await writeFile(
      file,
      JSON.stringify({
        services: {
          "payment-service": {
            owner: "team-payments",
            tier: "tier-1",
            dataClassification: "confidential",
            slo: "99.9%",
            runbooks: ["https://runbooks.example/payments"],
            tags: ["pci", "regulated"],
          },
        },
      }),
      "utf8",
    );
    const c = await readCatalogFile(file);
    assert.equal(c.services["payment-service"].owner, "team-payments");
    assert.equal(c.services["payment-service"].tier, "tier-1");
    assert.deepEqual(c.services["payment-service"].tags, ["pci", "regulated"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validateCatalog — rejects invalid tier values", () => {
  const c = validateCatalog({ services: { svc: { tier: "tier-9" } } });
  assert.equal(c.services.svc.tier, undefined);
});

test("validateCatalog — rejects invalid data classification", () => {
  const c = validateCatalog({ services: { svc: { dataClassification: "ultra-secret" } } });
  assert.equal(c.services.svc.dataClassification, undefined);
});

test("validateCatalog — strips non-string entries from runbooks / tags", () => {
  const c = validateCatalog({
    services: { svc: { runbooks: ["a", 1, "b", null], tags: [{}, "tag1"] } },
  });
  assert.deepEqual(c.services.svc.runbooks, ["a", "b"]);
  assert.deepEqual(c.services.svc.tags, ["tag1"]);
});

test("validateCatalog — skips non-object service entries", () => {
  const c = validateCatalog({ services: { svc1: "string", svc2: null, svc3: { owner: "team" } } });
  assert.equal(c.services.svc1, undefined);
  assert.equal(c.services.svc2, undefined);
  assert.equal(c.services.svc3.owner, "team");
});

test("CatalogStore — get / list / count / replace", () => {
  const store = new CatalogStore({
    services: {
      a: { owner: "team-a" },
      b: { owner: "team-b" },
    },
  });
  assert.equal(store.count(), 2);
  assert.equal(store.get("a")?.owner, "team-a");
  assert.equal(store.get("nope"), undefined);
  assert.equal(Object.keys(store.list()).length, 2);
  store.replace({ services: { x: { owner: "team-x" } } });
  assert.equal(store.count(), 1);
  assert.equal(store.get("x")?.owner, "team-x");
});
