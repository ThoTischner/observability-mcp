import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { validate, buildIndex, loadEntries } from "./build-catalog.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(HERE, "catalog-schema.json"), "utf8"));

const good = {
  catalogVersion: 1,
  name: "tempo",
  displayName: "Grafana Tempo",
  description: "TraceQL backend.",
  tier: "third-party",
  signalTypes: ["traces"],
  versions: [{ version: "1.0.0", releasedAt: "2026-05-15", integrity: "sha256-AAAA=" }],
};

test("a well-formed entry validates", () => {
  assert.deepEqual(validate(good, schema), []);
});

test("rejects unknown property (additionalProperties:false)", () => {
  const e = validate({ ...good, oops: 1 }, schema);
  assert.ok(e.some((m) => m.includes('unknown property "oops"')));
});

test("rejects bad name pattern, bad tier, bad version, bad integrity", () => {
  assert.ok(validate({ ...good, name: "Bad_Name" }, schema).some((m) => m.includes("name")));
  assert.ok(validate({ ...good, tier: "gold" }, schema).some((m) => m.includes("tier")));
  assert.ok(
    validate({ ...good, versions: [{ version: "v1", releasedAt: "2026-05-15" }] }, schema).some(
      (m) => m.includes("version")
    )
  );
  assert.ok(
    validate(
      { ...good, versions: [{ version: "1.0.0", releasedAt: "2026-05-15", integrity: "md5-x" }] },
      schema
    ).some((m) => m.includes("integrity"))
  );
});

test("rejects missing required field and bad date", () => {
  const { versions, ...noVer } = good;
  assert.ok(validate(noVer, schema).some((m) => m.includes('missing required "versions"')));
  assert.ok(
    validate({ ...good, versions: [{ version: "1.0.0", releasedAt: "May 2026" }] }, schema).some(
      (m) => m.includes("date")
    )
  );
});

test("all committed catalog entries are valid", () => {
  const { problems } = loadEntries();
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("committed index.json is in sync with the entries", () => {
  const { entries } = loadEntries();
  const expected = JSON.stringify(buildIndex(entries), null, 2) + "\n";
  const actual = readFileSync(join(HERE, "catalog", "index.json"), "utf8");
  assert.equal(actual, expected, "run `node hub/build-catalog.mjs` to regenerate");
});
