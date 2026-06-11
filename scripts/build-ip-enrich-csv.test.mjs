// End-to-end tests for build-ip-enrich-csv.mjs. Spawns the real script
// against synthetic MaxMind-shaped CSVs and asserts the enrich_ips output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "build-ip-enrich-csv.mjs");

const CITY_V4 = `network,geoname_id,registered_country_geoname_id,is_anonymous_proxy,is_satellite_provider,postal_code,latitude,longitude,accuracy_radius
1.2.3.0/24,5391959,5391959,0,0,,37.77,-122.41,20
10.0.0.0/8,2950159,2950159,0,0,,52.52,13.40,100`;

const CITY_V6 = `network,geoname_id,registered_country_geoname_id,is_anonymous_proxy,is_satellite_provider,postal_code,latitude,longitude,accuracy_radius
2001:db8::/32,5391959,5391959,0,0,,37.77,-122.41,20`;

const LOCATIONS = `geoname_id,locale_code,continent_code,continent_name,country_iso_code,country_name,city_name
5391959,en,NA,North America,US,United States,San Francisco
2950159,en,EU,Europe,DE,Germany,Berlin`;

// org name with an embedded comma → must be RFC-4180 quoted on the way in AND out.
const ASN_V4 = `network,autonomous_system_number,autonomous_system_organization
1.2.3.0/24,14618,"Amazon.com, Inc."
10.0.0.0/8,3320,Deutsche Telekom`;

async function run() {
  const dir = await mkdtemp(join(tmpdir(), "ipenrich-"));
  const f = (n) => join(dir, n);
  await writeFile(f("city4.csv"), CITY_V4);
  await writeFile(f("city6.csv"), CITY_V6);
  await writeFile(f("loc.csv"), LOCATIONS);
  await writeFile(f("asn4.csv"), ASN_V4);
  const out = f("enrich.csv");
  const r = spawnSync("node", [
    SCRIPT,
    "--city-blocks", f("city4.csv"),
    "--city-blocks", f("city6.csv"),
    "--locations", f("loc.csv"),
    "--asn-blocks", f("asn4.csv"),
    "--out", out,
  ], { encoding: "utf8" });
  const text = r.status === 0 ? await readFile(out, "utf8") : "";
  return { r, text, dir };
}

test("converts MaxMind GeoLite2 City+ASN (v4 + v6) into enrich_ips CSV", async () => {
  const { r, text, dir } = await run();
  try {
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    const lines = text.trim().split("\n");
    assert.equal(lines[0], "network,country,city,asn,org,hosting");

    // v4 row joined geo (US/San Francisco) + ASN (quoted org with a comma)
    const row1 = lines.find((l) => l.startsWith("1.2.3.0/24"));
    assert.ok(row1, "v4 row present");
    assert.match(row1, /^1\.2\.3\.0\/24,US,San Francisco,AS14618,"Amazon\.com, Inc\.",$/);

    // v4 row 2: Berlin + Deutsche Telekom (unquoted, no comma)
    const row2 = lines.find((l) => l.startsWith("10.0.0.0/8"));
    assert.match(row2, /^10\.0\.0\.0\/8,DE,Berlin,AS3320,Deutsche Telekom,$/);

    // v6 row joined geo (US/San Francisco), no ASN file match → blank asn/org
    const row6 = lines.find((l) => l.startsWith("2001:db8::/32"));
    assert.ok(row6, "v6 row present");
    assert.match(row6, /^2001:db8::\/32,US,San Francisco,,,$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("exits non-zero with usage when required args are missing", async () => {
  const r = spawnSync("node", [SCRIPT, "--out", "x.csv"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage:/);
});
