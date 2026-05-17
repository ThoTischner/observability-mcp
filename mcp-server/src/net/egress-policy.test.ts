import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import {
  OUTBOUND_PATTERN,
  FORBIDDEN_TELEMETRY,
  isEgressAllowed,
  EGRESS_ALLOWLIST,
} from "./egress-policy.js";

// Verifiable offline mode: static guard so the "no data egress" guarantee
// cannot silently regress. Any new outbound call outside the documented
// allowlist, or any analytics/telemetry SDK anywhere, fails CI here.
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("verifiable offline mode — egress policy", () => {
  const files = walk(srcRoot)
    .map((f) => ({
      rel: relative(srcRoot, f).replace(/\\/g, "/"),
      src: readFileSync(f, "utf8"),
    }))
    // The policy module itself names these tokens by design.
    .filter((f) => f.rel !== "net/egress-policy.ts");

  it("scans a non-trivial number of source files", () => {
    assert.ok(files.length > 20, `only scanned ${files.length} files`);
  });

  it("no outbound call outside the egress allowlist", () => {
    const breaches = files
      .filter((f) => OUTBOUND_PATTERN.test(f.src) && !isEgressAllowed(f.rel))
      .map((f) => f.rel);
    assert.deepEqual(
      breaches,
      [],
      `outbound calls found outside allowlist (${EGRESS_ALLOWLIST.map((a) => a.prefix).join(", ")}): ` +
        `${breaches.join(", ")} — telemetry/phone-home is forbidden; if legitimate, extend EGRESS_ALLOWLIST with a reason`
    );
  });

  it("no analytics/telemetry SDK anywhere in source", () => {
    const hits = files
      .filter((f) => FORBIDDEN_TELEMETRY.test(f.src))
      .map((f) => f.rel);
    assert.deepEqual(hits, [], `forbidden telemetry/analytics identifiers in: ${hits.join(", ")}`);
  });

  it("allowlisted files are still present (allowlist not stale)", () => {
    for (const { prefix } of EGRESS_ALLOWLIST) {
      const covered = files.some((f) => f.rel === prefix || f.rel.startsWith(prefix));
      assert.ok(covered, `allowlist entry "${prefix}" matches no source file — prune it`);
    }
  });
});
