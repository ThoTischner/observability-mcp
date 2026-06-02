/**
 * MCP Products — curated, agent-facing collections of tools.
 *
 * A Product is a named bundle that ships with branding metadata
 * (icon, description, version) plus a list of allowed MCP tools.
 * The agent calling /mcp can be told which Product it belongs to
 * (via a future header / arg, slice 2+), and the server can filter
 * tools/list and tools/call responses accordingly.
 *
 * Today's surface (slice 1):
 *   - In-memory ProductsStore loaded from OMCP_PRODUCTS_FILE
 *     (YAML or JSON). Missing/empty file → empty catalog.
 *   - Strict validation: unknown action / unknown resource /
 *     unexpected keys reject loudly.
 *   - Mtime-poll hot-reload: callers (e.g. each /api/products
 *     handler) `await store.maybeReload()` before reading. If the
 *     file mtime advanced since the last load, the store re-parses
 *     and atomically swaps the in-memory file; parse errors keep
 *     the previous good state and log loudly. One `stat()` call per
 *     reload-aware request — too cheap to matter vs. the network
 *     round-trip, no FSWatcher platform fragility (WSL / NFS).
 */

import { readFile, writeFile, rename, stat } from "node:fs/promises";
import yaml from "js-yaml";

export interface Product {
  /** Stable identifier — used in URLs, audit entries, /api/products/{id}. */
  id: string;
  /** Display name shown in the UI / agent dropdown. */
  name: string;
  /** One-sentence description. */
  description?: string;
  /** Allowed MCP tool names. Empty / undefined → all tools allowed. */
  tools?: string[];
  /** Operator-defined version label, e.g. "1.0.0" or "preview". */
  version?: string;
  /** Free-form branding metadata for the UI — icon URL, theme colour, etc. */
  branding?: {
    iconUrl?: string;
    color?: string;
  };
  /** Lifecycle stage: published = visible to agents; staging = admin-only. */
  status?: "published" | "staging";
  /** Tenant this product belongs to. Omitted → "default". */
  tenant?: string;
}

export interface ProductsFile {
  products: Product[];
}

const EMPTY: ProductsFile = { products: [] };
const VALID_STATUS = new Set(["published", "staging"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class ProductsLoadError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ProductsLoadError";
  }
}

export async function readProductsFile(path: string | undefined): Promise<ProductsFile> {
  if (!path) return EMPTY;
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return EMPTY;
    console.warn(`[products] could not read ${path}: ${(e as Error).message} — starting with empty catalog`);
    return EMPTY;
  }
  return parseProductsText(text, path);
}

export function parseProductsText(text: string, origin: string): ProductsFile {
  let parsed: unknown;
  try { parsed = yaml.load(text); }
  catch (e) { throw new ProductsLoadError(`${origin}: not valid YAML/JSON: ${(e as Error).message}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProductsLoadError(`${origin}: root must be an object with a 'products' array`);
  }
  const root = parsed as Record<string, unknown>;
  const rawProducts = root.products;
  if (!Array.isArray(rawProducts)) {
    throw new ProductsLoadError(`${origin}: 'products' must be an array`);
  }
  const out: Product[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < rawProducts.length; i++) {
    const e = rawProducts[i];
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      throw new ProductsLoadError(`${origin}: products[${i}] must be an object`);
    }
    const r = e as Record<string, unknown>;
    if (typeof r.id !== "string" || !ID_RE.test(r.id)) {
      throw new ProductsLoadError(`${origin}: products[${i}].id must be a string matching ${ID_RE}`);
    }
    if (seenIds.has(r.id)) {
      throw new ProductsLoadError(`${origin}: duplicate product id '${r.id}'`);
    }
    seenIds.add(r.id);
    if (typeof r.name !== "string" || !r.name) {
      throw new ProductsLoadError(`${origin}: products[${i}].name must be a non-empty string`);
    }
    const p: Product = { id: r.id, name: r.name };
    if (r.description !== undefined) {
      if (typeof r.description !== "string") throw new ProductsLoadError(`${origin}: products[${i}].description must be a string`);
      p.description = r.description;
    }
    if (r.tools !== undefined) {
      if (!Array.isArray(r.tools) || !r.tools.every((t) => typeof t === "string")) {
        throw new ProductsLoadError(`${origin}: products[${i}].tools must be an array of strings`);
      }
      p.tools = r.tools as string[];
    }
    if (r.version !== undefined) {
      if (typeof r.version !== "string") throw new ProductsLoadError(`${origin}: products[${i}].version must be a string`);
      p.version = r.version;
    }
    if (r.status !== undefined) {
      if (typeof r.status !== "string" || !VALID_STATUS.has(r.status)) {
        throw new ProductsLoadError(`${origin}: products[${i}].status must be one of ${[...VALID_STATUS].join(", ")}`);
      }
      p.status = r.status as "published" | "staging";
    }
    if (r.tenant !== undefined) {
      if (typeof r.tenant !== "string") throw new ProductsLoadError(`${origin}: products[${i}].tenant must be a string`);
      p.tenant = r.tenant;
    }
    if (r.branding !== undefined) {
      if (!r.branding || typeof r.branding !== "object" || Array.isArray(r.branding)) {
        throw new ProductsLoadError(`${origin}: products[${i}].branding must be an object`);
      }
      const b = r.branding as Record<string, unknown>;
      p.branding = {};
      if (b.iconUrl !== undefined) {
        if (typeof b.iconUrl !== "string") throw new ProductsLoadError(`${origin}: products[${i}].branding.iconUrl must be a string`);
        p.branding.iconUrl = b.iconUrl;
      }
      if (b.color !== undefined) {
        if (typeof b.color !== "string") throw new ProductsLoadError(`${origin}: products[${i}].branding.color must be a string`);
        p.branding.color = b.color;
      }
    }
    // Reject unexpected top-level keys — operator typo guard
    for (const k of Object.keys(r)) {
      if (!["id", "name", "description", "tools", "version", "branding", "status", "tenant"].includes(k)) {
        throw new ProductsLoadError(`${origin}: products[${i}] has unexpected key '${k}'`);
      }
    }
    out.push(p);
  }
  return { products: out };
}

/** In-memory store with tenant- and status-aware queries. */
export class ProductsStore {
  /** Optional source file path. When set, `maybeReload()` polls its
   *  mtime and re-parses on change. Mutations via upsert/delete update
   *  `lastMtimeMs` after the caller persists, so the store does not
   *  reload its own writes. */
  private path?: string;
  private lastMtimeMs = 0;

  constructor(private file: ProductsFile = EMPTY, opts: { path?: string; initialMtimeMs?: number } = {}) {
    this.path = opts.path;
    this.lastMtimeMs = opts.initialMtimeMs ?? 0;
  }

  /** Re-read the source file if its mtime has advanced since the last
   *  load. No-op when no path was supplied at construction. Parse or
   *  IO errors are logged and the previous good state is kept — the
   *  invariant is "the store always reflects a valid catalogue", so a
   *  broken edit on disk never takes the running server down. */
  async maybeReload(): Promise<{ reloaded: boolean }> {
    if (!this.path) return { reloaded: false };
    let mtimeMs: number;
    try {
      const s = await stat(this.path);
      mtimeMs = s.mtimeMs;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // File gone (ENOENT) — keep last good state. Re-creating the
      // file will land in this branch's else on the next call when
      // stat succeeds again with a fresh mtime.
      if (code !== "ENOENT") {
        console.warn(`[products] hot-reload stat(${this.path}) failed: ${(e as Error).message} — keeping previous catalogue`);
      }
      return { reloaded: false };
    }
    if (mtimeMs <= this.lastMtimeMs) return { reloaded: false };
    let next: ProductsFile;
    try {
      next = await readProductsFile(this.path);
    } catch (e) {
      // readProductsFile downgrades IO errors to EMPTY but lets
      // parse errors (ProductsLoadError) propagate — so a broken
      // YAML edit lands here, and we explicitly do NOT swap state.
      console.warn(`[products] hot-reload of ${this.path} failed: ${(e as Error).message} — keeping previous catalogue`);
      // Bump the mtime cursor anyway so we don't re-log the same
      // failure on every subsequent request until the operator fixes
      // the file (next save advances mtime past this value).
      this.lastMtimeMs = mtimeMs;
      return { reloaded: false };
    }
    this.file = next;
    this.lastMtimeMs = mtimeMs;
    return { reloaded: true };
  }

  /** Re-stat the source file and pin the mtime cursor to its current
   *  value. Call this after a successful write so the store does not
   *  treat its own change as an external reload trigger. Best-effort:
   *  if the stat fails, the next maybeReload() will simply reload the
   *  file once and find it identical. */
  async pinMtimeAfterWrite(): Promise<void> {
    if (!this.path) return;
    try {
      const s = await stat(this.path);
      this.lastMtimeMs = s.mtimeMs;
    } catch {
      // Silent — see method JSDoc.
    }
  }

  /** Return the product list. When `tenant` is set, filters to that
   *  tenant (entries without a tenant field treated as "default").
   *  When `includeStaging` is false (default), staging products are
   *  hidden from the result — admins should pass true. */
  list(opts: { tenant?: string; includeStaging?: boolean } = {}): Product[] {
    return this.file.products.filter((p) => {
      if (opts.tenant) {
        const pt = p.tenant || "default";
        if (pt !== opts.tenant) return false;
      }
      if (!opts.includeStaging && p.status === "staging") return false;
      return true;
    });
  }

  /** Lookup by id. Cross-tenant gets return undefined when `tenant` set. */
  get(id: string, tenant?: string): Product | undefined {
    const p = this.file.products.find((x) => x.id === id);
    if (!p) return undefined;
    if (tenant && (p.tenant || "default") !== tenant) return undefined;
    return p;
  }

  count(tenant?: string): number {
    return this.list({ tenant, includeStaging: true }).length;
  }

  replace(file: ProductsFile): void {
    this.file = file;
  }

  /** Upsert (replace if id exists, else append). Returns the new
   *  ProductsFile so the caller can persist it. */
  upsert(product: Product): ProductsFile {
    const i = this.file.products.findIndex((p) => p.id === product.id);
    const next: Product[] = this.file.products.slice();
    if (i >= 0) next[i] = product;
    else next.push(product);
    this.file = { products: next };
    return this.file;
  }

  /** Remove by id. Returns true when the product existed, false
   *  otherwise. Caller persists the resulting file. */
  delete(id: string): { removed: boolean; file: ProductsFile } {
    const i = this.file.products.findIndex((p) => p.id === id);
    if (i < 0) return { removed: false, file: this.file };
    const next = this.file.products.slice();
    next.splice(i, 1);
    this.file = { products: next };
    return { removed: true, file: this.file };
  }

  /** Snapshot of the current file (for tests / persistence). */
  snapshot(): ProductsFile {
    return { products: this.file.products.slice() };
  }
}

/** Validate a single product entry by routing it through the same
 *  parser as the file format. Throws ProductsLoadError on any
 *  shape problem. Used by PUT /api/products/:id so a typo / wrong
 *  type / unknown key gets the same loud rejection a malformed
 *  file would. */
export function validateProduct(input: unknown, origin = "input"): Product {
  const wrapped = parseProductsText(yaml.dump({ products: [input] }), origin);
  return wrapped.products[0];
}

/** Atomic write of the products file. Same tmp+rename pattern as
 *  the audit-chain + token-budget snapshot, so a crash mid-write
 *  leaves the previous file intact. */
export async function writeProductsFile(path: string, file: ProductsFile): Promise<void> {
  const text = yaml.dump(file, { sortKeys: false, lineWidth: 100 });
  const tmp = path + ".tmp";
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}
