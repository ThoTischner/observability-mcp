import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { REGISTERED_TOOL_NAMES, unknownToolNames } from "./registry-names.js";

const here = dirname(fileURLToPath(import.meta.url));
const INDEX_TS = join(here, "..", "index.ts");

test("REGISTERED_TOOL_NAMES — 1:1 with createMcpServer's registerTool() calls", () => {
  // This is the integration-test-shaped guard: if a future PR adds
  // or removes a tool registration in index.ts without updating
  // REGISTERED_TOOL_NAMES, the Product validator will silently
  // accept or reject the wrong names. We parse index.ts as text and
  // assert the registered set matches the constant exactly.
  const src = readFileSync(INDEX_TS, "utf8");
  // registerTool("name", → captures the first argument of every call site.
  const re = /\bregisterTool\(\s*"([a-z_][a-z0-9_]*)"/g;
  const found: string[] = [];
  for (const m of src.matchAll(re)) found.push(m[1]);
  found.sort();
  const expected = [...REGISTERED_TOOL_NAMES].sort();
  assert.deepEqual(
    found,
    expected,
    `registerTool() call sites in index.ts don't match REGISTERED_TOOL_NAMES. ` +
      `Add or remove names in src/tools/registry-names.ts to match the actual ` +
      `registrations.\n  found: ${JSON.stringify(found)}\n  expected: ${JSON.stringify(expected)}`,
  );
});

test("unknownToolNames — empty input → no unknowns", () => {
  assert.deepEqual(unknownToolNames([]), []);
});

test("unknownToolNames — every registered name is accepted", () => {
  assert.deepEqual(unknownToolNames([...REGISTERED_TOOL_NAMES]), []);
});

test("unknownToolNames — surfaces typos and unknown names verbatim", () => {
  const r = unknownToolNames(["list_sources", "query_logz", "get_topologyy"]);
  assert.deepEqual(r, ["query_logz", "get_topologyy"]);
});

test("unknownToolNames — case-sensitive (MCP spec)", () => {
  // The spec requires exact name match; "List_Sources" is not the
  // same tool as "list_sources" and silently accepting it would be a
  // worse failure mode than rejecting (mismatched casing wouldn't
  // route to a real tool).
  assert.deepEqual(unknownToolNames(["List_Sources"]), ["List_Sources"]);
});
