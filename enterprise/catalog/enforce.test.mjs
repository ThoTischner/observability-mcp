import { test } from "node:test";
import assert from "node:assert/strict";
import { enforceCatalog, checkCatalog, CatalogDeniedError } from "./enforce.mjs";

const CATALOG = {
  products: {
    "eu-payments": { sources: ["prom-eu"], services: ["payment-service"] },
  },
  grants: { "key:alice": ["eu-payments"] },
};

const ctx = (over = {}) => ({ principalId: "key:alice", auth: "apikey", correlationId: "c1", ...over });

test("enforceCatalog returns the allow decision when in a granted product", () => {
  const d = enforceCatalog(CATALOG, ctx(), { source: "prom-eu", service: "payment-service" });
  assert.equal(d.allow, true);
  assert.equal(d.product, "eu-payments");
});

test("enforceCatalog throws CatalogDeniedError outside any granted product", () => {
  let ran = false;
  try {
    enforceCatalog(CATALOG, ctx(), { source: "prom-us" });
    ran = true;
  } catch (e) {
    assert.ok(e instanceof CatalogDeniedError);
    assert.equal(e.code, "CATALOG_DENIED");
    assert.match(e.message, /outside every granted product/);
    assert.equal(e.request.source, "prom-us");
  }
  assert.equal(ran, false);
});

test("context allowedSources is a hard upper bound the catalog cannot exceed", () => {
  const d = checkCatalog(CATALOG, ctx({ allowedSources: ["prom-eu"] }), { source: "prom-xx" });
  assert.equal(d.allow, false);
  assert.match(d.reason, /outside the context allow-list/);
  assert.equal(
    checkCatalog(CATALOG, ctx({ allowedSources: ["prom-eu"] }), { source: "prom-eu", service: "payment-service" }).allow,
    true
  );
});

test("anonymous / ungranted principal is denied (default-deny seam)", () => {
  const d = checkCatalog(CATALOG, { principalId: "anonymous", auth: "anonymous" }, { source: "prom-eu" });
  assert.equal(d.allow, false);
  assert.match(d.reason, /no product grants \(default-deny\)/);
});

test("checkCatalog never throws, returns the decision", () => {
  const d = checkCatalog(CATALOG, ctx(), { source: "prom-us" });
  assert.equal(d.allow, false);
  assert.equal(typeof d.reason, "string");
});

test("missing ctx → anonymous → denied", () => {
  assert.equal(checkCatalog(CATALOG, undefined, { source: "prom-eu" }).allow, false);
});
