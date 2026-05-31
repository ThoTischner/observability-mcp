import { test } from "node:test";
import assert from "node:assert/strict";

import { parseProductsText, ProductsStore, ProductsLoadError } from "./loader.js";

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

test("ProductsLoadError is the throw class", () => {
  try { parseProductsText("not-json", "t"); }
  catch (e) {
    assert.ok(e instanceof ProductsLoadError);
    return;
  }
  assert.fail("expected throw");
});
