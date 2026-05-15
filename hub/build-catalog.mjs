#!/usr/bin/env node
// Validates every hub/catalog/<name>.json against catalog-schema.json and
// aggregates them into hub/catalog/index.json (the single file a static
// hub site / the future CLI fetches). Dependency-free: a focused
// validator covering exactly the JSON Schema constructs the schema uses
// (const, enum, pattern, type, required, additionalProperties:false,
// minItems/minLength, nested objects/arrays, uri/date format). No ajv so
// this runs in an airgapped checkout with bare `node`.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = join(HERE, "catalog");
const SCHEMA_PATH = join(HERE, "catalog-schema.json");
const INDEX_PATH = join(CATALOG_DIR, "index.json");

const URI_RE = /^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validate(node, schema, path = "") {
  const errs = [];
  const at = path || "<root>";

  if (schema.const !== undefined && node !== schema.const) {
    errs.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
    return errs;
  }
  if (schema.enum && !schema.enum.includes(node)) {
    errs.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`);
    return errs;
  }

  const type = schema.type;
  if (type === "object") {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      errs.push(`${at}: expected object`);
      return errs;
    }
    for (const req of schema.required ?? []) {
      if (!(req in node)) errs.push(`${at}: missing required "${req}"`);
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(node)) {
        if (!(k in (schema.properties ?? {}))) errs.push(`${at}: unknown property "${k}"`);
      }
    }
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in node) errs.push(...validate(node[k], sub, path ? `${path}.${k}` : k));
    }
    return errs;
  }
  if (type === "array") {
    if (!Array.isArray(node)) {
      errs.push(`${at}: expected array`);
      return errs;
    }
    if (schema.minItems != null && node.length < schema.minItems) {
      errs.push(`${at}: needs >= ${schema.minItems} items`);
    }
    node.forEach((el, i) => errs.push(...validate(el, schema.items, `${at}[${i}]`)));
    return errs;
  }
  if (type === "string") {
    if (typeof node !== "string") {
      errs.push(`${at}: expected string`);
      return errs;
    }
    if (schema.minLength != null && node.length < schema.minLength) {
      errs.push(`${at}: shorter than ${schema.minLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(node)) {
      errs.push(`${at}: does not match /${schema.pattern}/`);
    }
    if (schema.format === "uri" && !URI_RE.test(node)) errs.push(`${at}: not a URI`);
    if (schema.format === "date" && !DATE_RE.test(node)) errs.push(`${at}: not a YYYY-MM-DD date`);
    return errs;
  }
  if (type === "boolean" && typeof node !== "boolean") errs.push(`${at}: expected boolean`);
  return errs;
}

export function buildIndex(entries) {
  const connectors = entries
    .map((e) => ({
      name: e.name,
      displayName: e.displayName,
      description: e.description,
      tier: e.tier,
      builtin: e.builtin === true,
      signalTypes: e.signalTypes,
      latest: e.versions[0].version,
      versions: e.versions,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { catalogVersion: 1, connectors };
}

export function loadEntries() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const files = readdirSync(CATALOG_DIR)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .sort();
  const entries = [];
  const problems = [];
  for (const f of files) {
    const entry = JSON.parse(readFileSync(join(CATALOG_DIR, f), "utf8"));
    const errs = validate(entry, schema);
    if (f !== `${entry.name}.json`) {
      errs.push(`<root>: filename must be "${entry.name}.json"`);
    }
    if (errs.length) problems.push(`${f}:\n  - ${errs.join("\n  - ")}`);
    else entries.push(entry);
  }
  return { entries, problems };
}

// CLI: validate + (re)write index.json. `--check` fails if out of sync.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { entries, problems } = loadEntries();
  if (problems.length) {
    console.error("Catalog validation failed:\n" + problems.join("\n"));
    process.exit(1);
  }
  const index = buildIndex(entries);
  const serialized = JSON.stringify(index, null, 2) + "\n";
  if (process.argv.includes("--check")) {
    const current = readFileSync(INDEX_PATH, "utf8");
    if (current !== serialized) {
      console.error("hub/catalog/index.json is stale — run `node hub/build-catalog.mjs`");
      process.exit(1);
    }
    console.log(`Catalog OK (${entries.length} connectors), index.json in sync.`);
  } else {
    writeFileSync(INDEX_PATH, serialized);
    console.log(`Wrote ${INDEX_PATH} (${entries.length} connectors).`);
  }
}
