import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Regression guard for issue #415: the query_logs handler (query-logs.ts)
// reads `labels` and `aggregate` from its args, and validateLogLabels /
// validateLogAggregate enforce them — but the MCP-facing input schema is
// declared INLINE in createMcpServer's registerTool("query_logs", …) block
// in index.ts. In v3.1.0 that inline schema was never updated to advertise
// `labels`/`aggregate`, so the MCP SDK stripped those keys before they
// reached the handler: the params were unreachable over MCP and passing
// them was a silent no-op. The handler unit tests passed because they call
// the handler directly, bypassing the SDK schema layer.
//
// This test parses index.ts and asserts the query_logs registration block
// declares both fields as schema entries, so the SDK validates and forwards
// them. The live equivalent (real tools/list handshake) lives in the
// conformance suite; this is the fast, server-less guard.

const here = dirname(fileURLToPath(import.meta.url));
const INDEX_TS = join(here, "..", "index.ts");

function registerToolBlock(src: string, tool: string): string {
  const start = src.indexOf(`registerTool(\n    "${tool}"`);
  assert.notEqual(start, -1, `registerTool("${tool}", …) not found in index.ts`);
  // The block ends at the next registerTool( call (or EOF).
  const next = src.indexOf("registerTool(", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

test("query_logs MCP schema advertises `labels` (issue #415 #1)", () => {
  const block = registerToolBlock(readFileSync(INDEX_TS, "utf8"), "query_logs");
  assert.match(
    block,
    /\blabels:\s*z\b/,
    "query_logs registration in index.ts must declare a `labels` schema field " +
      "so the MCP SDK forwards it to the handler (else it is silently stripped).",
  );
});

test("query_logs MCP schema advertises `aggregate` (issue #415 #2)", () => {
  const block = registerToolBlock(readFileSync(INDEX_TS, "utf8"), "query_logs");
  assert.match(
    block,
    /\baggregate:\s*z\b/,
    "query_logs registration in index.ts must declare an `aggregate` schema field " +
      "so the MCP SDK forwards it to the handler (else it is silently stripped).",
  );
});
