import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ipv4ToInt, parseCidr, ipv6ToBigInt, parseCidr6, IpEnrichmentDataset } from "./ip-dataset.js";

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
    "2001:db8::/32,XX,,,,", // IPv6 — now parsed, not skipped
    "garbage-row",
  ].join("\n");

  it("parses rows (v4 + v6), skips header/comments/blank, counts skipped", () => {
    const ds = IpEnrichmentDataset.fromCsv(csv);
    assert.equal(ds.size, 4); // 3 IPv4 + 1 IPv6 row
    assert.equal(ds.skipped, 1); // only the garbage row
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

describe("ipv6ToBigInt", () => {
  it("parses a full address", () => {
    assert.equal(ipv6ToBigInt("2001:0db8:0000:0000:0000:0000:0000:0001"), 0x20010db8000000000000000000000001n);
  });
  it("expands :: zero-compression", () => {
    assert.equal(ipv6ToBigInt("2001:db8::1"), 0x20010db8000000000000000000000001n);
    assert.equal(ipv6ToBigInt("::1"), 1n);
    assert.equal(ipv6ToBigInt("::"), 0n);
    assert.equal(ipv6ToBigInt("ff02::"), 0xff020000000000000000000000000000n);
  });
  it("parses an IPv4-mapped tail", () => {
    // ::ffff:1.2.3.4 → the v4 lives in the low 32 bits with ffff above it
    assert.equal(ipv6ToBigInt("::ffff:1.2.3.4"), 0x00000000000000000000ffff01020304n);
  });
  it("rejects malformed input", () => {
    assert.equal(ipv6ToBigInt("2001:db8::1::2"), null); // two ::
    assert.equal(ipv6ToBigInt("gggg::1"), null);
    assert.equal(ipv6ToBigInt("1.2.3.4"), null); // v4 is not v6
    assert.equal(ipv6ToBigInt("12345::"), null); // hextet too long
    assert.equal(ipv6ToBigInt(""), null);
  });
});

describe("parseCidr6", () => {
  it("parses a /32 to its inclusive range", () => {
    const r = parseCidr6("2001:db8::/32");
    assert.equal(r?.prefix, 32);
    assert.equal(r?.start, 0x20010db8000000000000000000000000n);
    assert.equal(r?.end, 0x20010db8ffffffffffffffffffffffffn);
  });
  it("treats a bare address as /128", () => {
    const r = parseCidr6("2001:db8::1");
    assert.equal(r?.prefix, 128);
    assert.equal(r?.start, r?.end);
  });
  it("handles /0 (whole space)", () => {
    const r = parseCidr6("::/0");
    assert.equal(r?.start, 0n);
    assert.equal(r?.end, (1n << 128n) - 1n);
  });
  it("rejects bad prefixes / addresses", () => {
    assert.equal(parseCidr6("2001:db8::/129"), null);
    assert.equal(parseCidr6("nope::/32"), null);
  });
});

describe("IpEnrichmentDataset IPv6 lookup", () => {
  const csv = [
    "network,country,city,asn,org,hosting",
    "2001:db8::/32,US,,AS100,Example Cloud,true",
    "2001:db8:1::/48,US,Ashburn,AS100,Example Cloud Edge,true",
    "2606:4700::/32,US,,AS13335,Example CDN,true",
    "10.0.0.0/8,DE,Berlin,AS3320,Example ISP,false", // v4 row alongside
  ].join("\n");

  it("returns the most specific v6 match", () => {
    const ds = IpEnrichmentDataset.fromCsv(csv);
    const hit = ds.lookup("2001:db8:1::abcd"); // inside both /32 and /48
    assert.equal(hit?.city, "Ashburn");
    assert.equal(hit?.org, "Example Cloud Edge");
  });
  it("falls back to the broader v6 range", () => {
    const ds = IpEnrichmentDataset.fromCsv(csv);
    const hit = ds.lookup("2001:db8:9::1"); // only in /32
    assert.equal(hit?.asn, "AS100");
    assert.equal(hit?.city, undefined);
  });
  it("keeps v4 and v6 lookups independent", () => {
    const ds = IpEnrichmentDataset.fromCsv(csv);
    assert.equal(ds.lookup("10.1.2.3")?.country, "DE"); // v4 path
    assert.equal(ds.lookup("2606:4700::1")?.org, "Example CDN"); // v6 path
    assert.equal(ds.lookup("2607:f8b0::1"), null); // unmatched v6
  });
  it("normalises an IPv4-mapped query against a v4 row? no — :: form hits v6 table only", () => {
    const ds = IpEnrichmentDataset.fromCsv(csv);
    // A ':'-bearing query goes to the v6 table; it won't match the 10.0.0.0/8 v4 row.
    assert.equal(ds.lookup("::ffff:10.1.2.3"), null);
  });
});
