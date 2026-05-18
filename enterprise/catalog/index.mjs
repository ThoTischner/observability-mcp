// Public surface of the FSL Catalog/Products module (FSL-1.1-Apache-2.0).
export {
  evaluateCatalog,
  resolveProducts,
  productScope,
  grantedProductNames,
} from "./catalog.mjs";
export { enforceCatalog, checkCatalog, CatalogDeniedError } from "./enforce.mjs";
