import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Keystone guard: every tool handler must accept the RequestContext seam.
// This prevents a new handler (or a refactor) from silently bypassing the
// request-scoped context that access-control / scoping / audit attach to.
const here = dirname(fileURLToPath(import.meta.url));

describe("RequestContext seam", () => {
  const handlerFiles = readdirSync(here).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts")
  );

  for (const file of handlerFiles) {
    const src = readFileSync(join(here, file), "utf8");
    const hasHandler = /export\s+(async\s+)?function\s+\w*Handler\s*\(/.test(src);
    if (!hasHandler) continue;

    it(`${file}: handler accepts a RequestContext`, () => {
      assert.match(
        src,
        /_ctx:\s*RequestContext/,
        `${file} exports a *Handler but does not thread RequestContext — ` +
          `add the ctx seam (see context.ts)`
      );
      assert.match(
        src,
        /from "\.\.\/context\.js"/,
        `${file} must import from ../context.js`
      );
    });
  }
});
