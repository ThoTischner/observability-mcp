// Governed product catalog (FSL-1.1-Apache-2.0).
//
// A Catalog publishes named **products** — curated bundles of
// observability scope (which sources / services / tools belong together
// as one consumable unit) — and **grants** that say which principals may
// consume which products. It is the "what is this principal even allowed
// to see as a unit" layer; RBAC (enterprise/rbac) is the orthogonal
// "what verbs may they perform" layer. Defence in depth: a request must
// pass BOTH.
//
// Pure and dependency-free: a catalog + a request in, a decision out.
// DEFAULT-DENY — a principal with no product grant sees nothing.
//
// Model
// -----
//   Catalog = { products, grants, defaultProducts? }
//     products : { <name>: Product }
//     grants   : { <principalId>: string[] }   // product names
//     defaultProducts?: string[]               // for ungranted principals
//   Product = { description?, sources, services?, tools? }
//     sources           : string[] (required) — "*" = any
//     services?/tools?   : string[] — omitted = unrestricted on that axis
//
// A request { source?, service?, tool? } is "in" a product iff every
// SPECIFIED axis is permitted by that product. An omitted product axis
// (services/tools) means that axis is unrestricted; an omitted/empty
// `sources` permits nothing (default-deny on the defining axis).

function axisAllows(list, value, { emptyMeans }) {
  if (!Array.isArray(list) || list.length === 0) return emptyMeans === "all";
  if (list.includes("*")) return true;
  return value != null && list.includes(value);
}

function requestInProduct(product, req) {
  if (!product || typeof product !== "object") return false;
  // sources: defining axis — empty/omitted denies.
  if (req.source != null && !axisAllows(product.sources, req.source, { emptyMeans: "none" })) {
    return false;
  }
  // services / tools: omitted axis = unrestricted.
  if (req.service != null && !axisAllows(product.services, req.service, { emptyMeans: "all" })) {
    return false;
  }
  if (req.tool != null && !axisAllows(product.tools, req.tool, { emptyMeans: "all" })) {
    return false;
  }
  return true;
}

/** Product names granted to a principal (falls back to defaultProducts). */
export function grantedProductNames(catalog, principalId) {
  const g = (catalog && catalog.grants && catalog.grants[principalId]) || null;
  if (g && g.length > 0) return g;
  return (catalog && catalog.defaultProducts) || [];
}

/** Resolved Product objects granted to a principal (skips unknown names). */
export function resolveProducts(catalog, principalId) {
  const names = grantedProductNames(catalog, principalId);
  const out = [];
  for (const n of names) {
    const p = catalog && catalog.products && catalog.products[n];
    if (p) out.push({ name: n, ...p });
  }
  return out;
}

/**
 * Flattened effective scope across all granted products (union).
 * "*" on an axis collapses to the wildcard. An omitted services/tools
 * axis on ANY granted product makes that axis unrestricted (most
 * permissive granted product wins, consistent with requestInProduct).
 */
export function productScope(catalog, principalId) {
  const products = resolveProducts(catalog, principalId);
  const scope = { sources: new Set(), services: new Set(), tools: new Set() };
  let servicesUnrestricted = false;
  let toolsUnrestricted = false;
  for (const p of products) {
    for (const s of p.sources || []) scope.sources.add(s);
    if (!Array.isArray(p.services) || p.services.length === 0) servicesUnrestricted = true;
    else for (const s of p.services) scope.services.add(s);
    if (!Array.isArray(p.tools) || p.tools.length === 0) toolsUnrestricted = true;
    else for (const t of p.tools) scope.tools.add(t);
  }
  return { ...scope, servicesUnrestricted, toolsUnrestricted };
}

/**
 * Is the request inside ANY product granted to the principal?
 * @returns {{allow: boolean, reason: string, product?: string}}
 */
export function evaluateCatalog(catalog, request) {
  if (!catalog || typeof catalog !== "object") {
    return { allow: false, reason: "no catalog configured (default-deny)" };
  }
  const req = request || {};
  const products = resolveProducts(catalog, req.principalId);
  if (products.length === 0) {
    return {
      allow: false,
      reason: `principal '${req.principalId ?? "?"}' has no product grants (default-deny)`,
    };
  }
  const tried = [];
  for (const p of products) {
    if (requestInProduct(p, req)) {
      return { allow: true, reason: `within product '${p.name}'`, product: p.name };
    }
    tried.push(p.name);
  }
  return {
    allow: false,
    reason: `request outside every granted product [${tried.join(", ")}]`,
  };
}
