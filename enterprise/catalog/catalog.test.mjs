import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateCatalog,
  resolveProducts,
  productScope,
  grantedProductNames,
} from "./catalog.mjs";

const CATALOG = {
  products: {
    "eu-payments": { description: "EU payment stack", sources: ["prom-eu", "loki-eu"], services: ["payment-service"] },
    "eu-all": { sources: ["prom-eu", "loki-eu"] }, // services/tools unrestricted
    "global-readonly": { sources: ["*"], tools: ["query_metrics", "get_service_health"] },
  },
  grants: {
    alice: ["eu-payments"],
    bob: ["eu-all", "global-readonly"],
  },
  defaultProducts: [],
};

test("default-deny: no catalog / ungranted principal", () => {
  assert.equal(evaluateCatalog(null, { principalId: "x", source: "s" }).allow, false);
  const d = evaluateCatalog(CATALOG, { principalId: "ghost", source: "prom-eu" });
  assert.equal(d.allow, false);
  assert.match(d.reason, /no product grants \(default-deny\)/);
});

test("in-product when every specified axis matches", () => {
  const d = evaluateCatalog(CATALOG, { principalId: "alice", source: "prom-eu", service: "payment-service" });
  assert.equal(d.allow, true);
  assert.equal(d.product, "eu-payments");
});

test("outside product when source not in the product's sources", () => {
  const d = evaluateCatalog(CATALOG, { principalId: "alice", source: "prom-us" });
  assert.equal(d.allow, false);
  assert.match(d.reason, /outside every granted product \[eu-payments\]/);
});

test("service axis is enforced when the product restricts it", () => {
  const d = evaluateCatalog(CATALOG, { principalId: "alice", source: "prom-eu", service: "order-service" });
  assert.equal(d.allow, false);
});

test("omitted product axis = unrestricted (eu-all has no services/tools)", () => {
  const d = evaluateCatalog(CATALOG, { principalId: "bob", source: "prom-eu", service: "anything", tool: "any" });
  assert.equal(d.allow, true);
  assert.equal(d.product, "eu-all");
});

test("multi-product union: first fails, second allows", () => {
  // bob: eu-all (sources prom-eu/loki-eu) + global-readonly (sources *, tools limited)
  const d = evaluateCatalog(CATALOG, { principalId: "bob", source: "prom-us", tool: "query_metrics" });
  assert.equal(d.allow, true);
  assert.equal(d.product, "global-readonly");
});

test("wildcard-source product still enforces its tool axis", () => {
  const onlyGlobal = { products: CATALOG.products, grants: { z: ["global-readonly"] } };
  assert.equal(evaluateCatalog(onlyGlobal, { principalId: "z", source: "anywhere", tool: "query_metrics" }).allow, true);
  const denied = evaluateCatalog(onlyGlobal, { principalId: "z", source: "anywhere", tool: "delete_source" });
  assert.equal(denied.allow, false);
});

test("defaultProducts applied to ungranted principals", () => {
  const c = { products: { pub: { sources: ["prom-eu"] } }, grants: {}, defaultProducts: ["pub"] };
  assert.equal(evaluateCatalog(c, { principalId: "anyone", source: "prom-eu" }).allow, true);
  assert.equal(evaluateCatalog(c, { principalId: "anyone", source: "prom-us" }).allow, false);
});

test("unknown product names are skipped, not crashed", () => {
  const c = { products: {}, grants: { x: ["nope"] } };
  const d = evaluateCatalog(c, { principalId: "x", source: "s" });
  assert.equal(d.allow, false);
  assert.match(d.reason, /no product grants \(default-deny\)/);
});

test("grantedProductNames: grant wins, else default, else []", () => {
  assert.deepEqual(grantedProductNames(CATALOG, "alice"), ["eu-payments"]);
  assert.deepEqual(grantedProductNames({ grants: {}, defaultProducts: ["d"] }, "ghost"), ["d"]);
  assert.deepEqual(grantedProductNames({ grants: {} }, "ghost"), []);
});

test("resolveProducts returns named product objects, skipping unknowns", () => {
  const c = { products: { a: { sources: ["s1"] } }, grants: { p: ["a", "missing"] } };
  const r = resolveProducts(c, "p");
  assert.equal(r.length, 1);
  assert.equal(r[0].name, "a");
  assert.deepEqual(r[0].sources, ["s1"]);
});

test("productScope flattens the union + unrestricted axis flags", () => {
  const s = productScope(CATALOG, "bob");
  // bob = eu-all (prom-eu/loki-eu) ∪ global-readonly (sources "*")
  assert.deepEqual([...s.sources].sort(), ["*", "loki-eu", "prom-eu"]);
  // eu-all has no services/tools → both axes unrestricted across the union
  assert.equal(s.servicesUnrestricted, true);
  assert.equal(s.toolsUnrestricted, true);

  const sa = productScope(CATALOG, "alice");
  assert.deepEqual([...sa.sources].sort(), ["loki-eu", "prom-eu"]);
  assert.equal(sa.servicesUnrestricted, false);
  assert.deepEqual([...sa.services], ["payment-service"]);
  assert.equal(sa.toolsUnrestricted, true); // eu-payments omits tools
});
