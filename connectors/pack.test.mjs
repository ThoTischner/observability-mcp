import { test } from "node:test";
import assert from "node:assert/strict";

import { parsePackArgs, sha256Integrity, tarballName, planPack } from "./pack.mjs";

test("parsePackArgs", () => {
  assert.deepEqual(parsePackArgs(["connectors/datadog", "--out", "o", "--key", "k.pem"]), {
    dir: "connectors/datadog",
    outDir: "o",
    key: "k.pem",
  });
  const d = parsePackArgs(["connectors/datadog"]);
  assert.equal(d.dir, "connectors/datadog");
  assert.equal(d.outDir, "dist-connectors");
  assert.equal(d.key, undefined);
});

test("sha256Integrity / tarballName", () => {
  assert.match(sha256Integrity(Buffer.from("x")), /^sha256-[A-Za-z0-9+/]+=*$/);
  assert.equal(tarballName("datadog", "1.0.0"), "datadog-1.0.0.tgz");
});

test("planPack ok + fail-closed on stale integrity / marker mismatch", () => {
  const entry = Buffer.from("export default()=>({})\n");
  const integ = sha256Integrity(entry);
  const pkg = { observabilityMcp: { kind: "connector", name: "datadog", manifest: "./manifest.json" } };
  const man = { name: "datadog", version: "1.0.0", integrity: integ };
  assert.deepEqual(planPack(pkg, man, entry), {
    name: "datadog",
    version: "1.0.0",
    tarball: "datadog-1.0.0.tgz",
  });
  assert.throws(() => planPack(pkg, { ...man, integrity: "sha256-bad" }, entry), /integrity stale/);
  assert.throws(() => planPack(pkg, { ...man, name: "other" }, entry), /!= marker.name/);
  assert.throws(() => planPack({}, man, entry), /connector marker/);
});
