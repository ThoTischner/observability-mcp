import { test } from "node:test";
import assert from "node:assert/strict";

import { parseProductsText, ProductsStore, ProductsLoadError, readProductsFile } from "./loader.js";

test("parseProductsText — empty/minimal products array", () => {
  const f = parseProductsText("products: []", "test");
  assert.deepEqual(f.products, []);
});

test("parseProductsText — happy path with full shape", () => {
  const yaml = `
products:
  - id: ops-bundle
    name: Operations Bundle
    description: Tools for incident response.
    tools: [query_logs, query_metrics, get_service_health]
    version: 1.2.0
    status: published
    branding:
      iconUrl: https://example.test/icon.png
      color: "#3178c6"
  - id: dev-bundle
    name: Developer Bundle
    tools: [query_logs]
    status: staging
`;
  const f = parseProductsText(yaml, "test");
  assert.equal(f.products.length, 2);
  assert.equal(f.products[0].id, "ops-bundle");
  assert.deepEqual(f.products[0].tools, ["query_logs", "query_metrics", "get_service_health"]);
  assert.equal(f.products[0].status, "published");
  assert.equal(f.products[0].branding?.color, "#3178c6");
  assert.equal(f.products[1].status, "staging");
});

test("parseProductsText — rejects malformed root / non-array products", () => {
  assert.throws(() => parseProductsText("[]", "t"), /root must be an object/);
  assert.throws(() => parseProductsText("products: notalist", "t"), /'products' must be an array/);
});

test("parseProductsText — rejects bad id / missing name / duplicate id", () => {
  assert.throws(() => parseProductsText("products:\n  - id: '..bad'\n    name: x", "t"), /id must be a string matching/);
  assert.throws(() => parseProductsText("products:\n  - id: ok\n    name: ''", "t"), /name must be a non-empty string/);
  assert.throws(
    () => parseProductsText("products:\n  - id: dup\n    name: A\n  - id: dup\n    name: B", "t"),
    /duplicate product id 'dup'/,
  );
});

test("parseProductsText — rejects unknown status / wrong types", () => {
  assert.throws(() => parseProductsText("products:\n  - id: x\n    name: X\n    status: archived", "t"), /status must be one of/);
  assert.throws(() => parseProductsText("products:\n  - id: x\n    name: X\n    tools: 'string-not-array'", "t"), /tools must be an array/);
  assert.throws(() => parseProductsText("products:\n  - id: x\n    name: X\n    version: 42", "t"), /version must be a string/);
});

test("parseProductsText — rejects unexpected top-level keys (typo guard)", () => {
  assert.throws(
    () => parseProductsText("products:\n  - id: x\n    name: X\n    toolss: []", "t"),
    /unexpected key 'toolss'/,
  );
});

test("parseProductsText — rejects malformed branding shape", () => {
  assert.throws(
    () => parseProductsText("products:\n  - id: x\n    name: X\n    branding: notobject", "t"),
    /branding must be an object/,
  );
  assert.throws(
    () => parseProductsText("products:\n  - id: x\n    name: X\n    branding:\n      iconUrl: 42", "t"),
    /branding.iconUrl must be a string/,
  );
});

test("ProductsStore — list / get / count happy paths", () => {
  const store = new ProductsStore({
    products: [
      { id: "a", name: "A", status: "published" },
      { id: "b", name: "B", status: "staging" },
      { id: "c", name: "C" }, // no explicit status → not "staging" → visible by default
    ],
  });
  // Default: staging hidden
  assert.equal(store.list().length, 2);
  // Include staging
  assert.equal(store.list({ includeStaging: true }).length, 3);
  // get unfiltered
  assert.equal(store.get("a")?.name, "A");
  assert.equal(store.get("missing"), undefined);
  // count includes everything
  assert.equal(store.count(), 3);
});

test("ProductsStore — tenant filter scopes list / get / count", () => {
  const store = new ProductsStore({
    products: [
      { id: "acme-ops", name: "Acme Ops", tenant: "acme" },
      { id: "bigco-ops", name: "BigCo Ops", tenant: "bigco" },
      { id: "shared", name: "Shared" }, // no tenant → "default"
    ],
  });
  // Tenant-scoped
  assert.equal(store.list({ tenant: "acme" }).length, 1);
  assert.equal(store.get("acme-ops", "acme")?.name, "Acme Ops");
  assert.equal(store.get("bigco-ops", "acme"), undefined, "cross-tenant get returns undefined");
  assert.equal(store.count("default"), 1, "no-tenant entry counts under 'default'");
});

test("ProductsStore — staging hidden by default within a tenant filter", () => {
  const store = new ProductsStore({
    products: [
      { id: "p1", name: "P1", tenant: "acme", status: "published" },
      { id: "p2", name: "P2", tenant: "acme", status: "staging" },
    ],
  });
  assert.equal(store.list({ tenant: "acme" }).length, 1, "staging is hidden");
  assert.equal(store.list({ tenant: "acme", includeStaging: true }).length, 2);
});

test("ProductsStore.upsert — replaces existing, appends new", () => {
  const store = new ProductsStore({
    products: [
      { id: "a", name: "Original" },
      { id: "b", name: "Second" },
    ],
  });
  // Replace existing
  store.upsert({ id: "a", name: "Replaced" });
  assert.equal(store.get("a")?.name, "Replaced");
  assert.equal(store.count(), 2);
  // Append new
  store.upsert({ id: "c", name: "New" });
  assert.equal(store.count(), 3);
  assert.equal(store.get("c")?.name, "New");
});

test("ProductsStore.delete — returns removed flag + survivors", () => {
  const store = new ProductsStore({
    products: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
  });
  const r1 = store.delete("a");
  assert.equal(r1.removed, true);
  assert.equal(store.count(), 1);
  // Re-delete is a no-op
  const r2 = store.delete("a");
  assert.equal(r2.removed, false);
  // Unknown id
  const r3 = store.delete("nope");
  assert.equal(r3.removed, false);
});

test("validateProduct — accepts a valid entry, rejects bad shape via same parser", async () => {
  // Happy path
  const p = await import("./loader.js").then((m) => m.validateProduct({ id: "x", name: "X" }));
  assert.equal(p.name, "X");
  // Bad shape uses the loader's strict rules
  const { validateProduct } = await import("./loader.js");
  assert.throws(() => validateProduct({ id: "x", name: "X", unknownKey: 1 }), /unexpected key 'unknownKey'/);
  assert.throws(() => validateProduct({ id: "..bad", name: "X" }), /id must be a string matching/);
});

test("writeProductsFile + readProductsFile — atomic round-trip", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeProductsFile, readProductsFile } = await import("./loader.js");
  const dir = await mkdtemp(join(tmpdir(), "omcp-products-"));
  try {
    const file = join(dir, "products.yaml");
    await writeProductsFile(file, {
      products: [
        { id: "a", name: "A", status: "published" },
        { id: "b", name: "B", tools: ["query_logs"], tenant: "acme" },
      ],
    });
    const reloaded = await readProductsFile(file);
    assert.equal(reloaded.products.length, 2);
    assert.equal(reloaded.products[0].status, "published");
    assert.equal(reloaded.products[1].tenant, "acme");
    assert.deepEqual(reloaded.products[1].tools, ["query_logs"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ProductsLoadError is the throw class", () => {
  try { parseProductsText("not-json", "t"); }
  catch (e) {
    assert.ok(e instanceof ProductsLoadError);
    return;
  }
  assert.fail("expected throw");
});

test("ProductsStore.maybeReload — picks up out-of-band edits on next call", async () => {
  const { mkdtemp, rm, writeFile, utimes } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "omcp-products-reload-"));
  try {
    const file = join(dir, "products.yaml");
    await writeFile(file, "products:\n  - id: a\n    name: A\n", "utf8");
    const initial = await readProductsFile(file);
    const store = new ProductsStore(initial, { path: file });
    await store.pinMtimeAfterWrite();
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].id, "a");
    // Simulate an out-of-band edit. Bump mtime explicitly because
    // some filesystems (WSL → 9P) round mtime to the second, so a
    // back-to-back write can land in the same second and look
    // unchanged to stat().
    await writeFile(file, "products:\n  - id: a\n    name: A\n  - id: b\n    name: B\n", "utf8");
    const future = new Date(Date.now() + 5_000);
    await utimes(file, future, future);
    const { reloaded } = await store.maybeReload();
    assert.equal(reloaded, true);
    assert.equal(store.list().length, 2);
    // A second call with no further edit is a no-op.
    const r2 = await store.maybeReload();
    assert.equal(r2.reloaded, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ProductsStore.maybeReload — broken YAML on disk keeps previous good state", async () => {
  const { mkdtemp, rm, writeFile, utimes } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "omcp-products-broken-"));
  try {
    const file = join(dir, "products.yaml");
    await writeFile(file, "products:\n  - id: a\n    name: A\n", "utf8");
    const store = new ProductsStore(await readProductsFile(file), { path: file });
    await store.pinMtimeAfterWrite();
    // Corrupt the file with an unknown top-level key — fails the
    // strict typo guard inside parseProductsText.
    await writeFile(file, "products:\n  - id: a\n    name: A\n    junk: true\n", "utf8");
    const future = new Date(Date.now() + 5_000);
    await utimes(file, future, future);
    const { reloaded } = await store.maybeReload();
    // We did NOT swap state — caller sees the previous good catalogue.
    assert.equal(reloaded, false);
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].name, "A");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ProductsStore.maybeReload — no path = no-op", async () => {
  const store = new ProductsStore({ products: [{ id: "a", name: "A" }] });
  const r = await store.maybeReload();
  assert.equal(r.reloaded, false);
  assert.equal(store.list().length, 1);
});

test("ProductsStore.pinMtimeAfterWrite — own writes do not trigger a redundant reload", async () => {
  const { mkdtemp, rm, writeFile, utimes } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeProductsFile } = await import("./loader.js");
  const dir = await mkdtemp(join(tmpdir(), "omcp-products-pin-"));
  try {
    const file = join(dir, "products.yaml");
    await writeFile(file, "products:\n  - id: a\n    name: A\n", "utf8");
    const store = new ProductsStore(await readProductsFile(file), { path: file });
    await store.pinMtimeAfterWrite();
    // Simulate the server-side mutate-then-persist path.
    store.upsert({ id: "b", name: "B" });
    // Move mtime forward so writeProductsFile genuinely advances it
    // past our cursor (1-second-resolution FS guard).
    const future = new Date(Date.now() + 5_000);
    await writeProductsFile(file, store.snapshot());
    await utimes(file, future, future);
    await store.pinMtimeAfterWrite();
    const { reloaded } = await store.maybeReload();
    assert.equal(reloaded, false, "own write must not re-trigger maybeReload");
    assert.equal(store.list().length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
