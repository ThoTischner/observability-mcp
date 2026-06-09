import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ipv4ToInt, parseCidr, IpEnrichmentDataset } from "./ip-dataset.js";

describe("ipv4ToInt", () => {
  it("parses valid IPv4", () => {
    assert.equal(ipv4ToInt("0.0.0.0"), 0);
    assert.equal(ipv4ToInt("255.255.255.255"), 4294967295);
    assert.equal(ipv4ToInt("1.2.3.4"), 0x01020304);
  });
  it("rejects malformed / out-of-range / non-IPv4", () => {
    assert.equal(ipv4ToInt("1.2.3"), null);
    assert.equal(ipv4ToInt("1.2.3.256"), null);
    assert.equal(ipv4ToInt("1.2.3.4.5"), null);
    assert.equal(ipv4ToInt("a.b.c.d"), null);
    assert.equal(ipv4ToInt("::1"), null);
    assert.equal(ipv4ToInt(""), null);
  });
});

describe("parseCidr", () => {
  it("parses a /24 to its inclusive range", () => {
    const r = parseCidr("1.2.3.0/24");
    assert.deepEqual(r, { start: 0x01020300, end: 0x010203ff, prefix: 24 });
  });
  it("treats a bare IP as /32", () => {
    const r = parseCidr("203.0.113.5");
    assert.equal(r?.prefix, 32);
    assert.equal(r?.start, r?.end);
  });
  it("normalises a non-aligned base to the network address", () => {
    // 1.2.3.42/24 → network 1.2.3.0
    const r = parseCidr("1.2.3.42/24");
    assert.equal(r?.start, 0x01020300);
  });
  it("handles /0 (whole space)", () => {
    const r = parseCidr("0.0.0.0/0");
    assert.deepEqual(r, { start: 0, end: 4294967295, prefix: 0 });
  });
  it("rejects bad prefixes / addresses", () => {
    assert.equal(parseCidr("1.2.3.0/33"), null);
    assert.equal(parseCidr("1.2.3.0/-1"), null);
    assert.equal(parseCidr("nope/24"), null);
  });
});

describe("IpEnrichmentDataset.fromCsv + lookup", () => {
  const csv = [
    "network,country,city,asn,org,hosting", // header skipped
    "# a comment line",
    "",
    "10.0.0.0/8,US,,AS100,Example Cloud,true",
    "10.1.2.0/24,US,Ashburn,AS100,Example Cloud Edge,true",
    "203.0.113.5,DE,Berlin,AS3320,Example ISP,false",
    "2001:db8::/32,XX,,,,", // IPv6 → skipped
    "garbage-row",
  ].join("\n");

  it("parses rows, skips header/comments/blank, counts skipped", () => {
    const ds = IpEnrichmentDataset.fromCsv(csv);
    assert.equal(ds.size, 3); // 3 valid IPv4 rows
    assert.equal(ds.skipped, 2); // IPv6 + garbage
  });

  it("returns the most specific (longest-prefix) match", () => {
    const ds = IpEnrichmentDataset.fromCsv(csv);
    // 10.1.2.5 is inside both /8 and /24 → the /24 (more specific) wins.
    const hit = ds.lookup("10.1.2.5");
    assert.equal(hit?.city, "Ashburn");
    assert.equal(hit?.org, "Example Cloud Edge");
    assert.equal(hit?.hosting, true);
  });

  it("falls back to the broader range when no specific one matches", () => {
    const ds = IpEnrichmentDataset.fromCsv(csv);
    const hit = ds.lookup("10.5.5.5"); // only in /8
    assert.equal(hit?.asn, "AS100");
    assert.equal(hit?.city, undefined); // empty cell omitted
  });

  it("matches a /32 exactly and parses hosting=false", () => {
    const ds = IpEnrichmentDataset.fromCsv(csv);
    const hit = ds.lookup("203.0.113.5");
    assert.equal(hit?.country, "DE");
    assert.equal(hit?.hosting, false);
  });

  it("returns null for an unmatched or invalid IP", () => {
    const ds = IpEnrichmentDataset.fromCsv(csv);
    assert.equal(ds.lookup("8.8.8.8"), null);
    assert.equal(ds.lookup("not-an-ip"), null);
  });
});
