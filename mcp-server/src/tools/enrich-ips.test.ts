import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IpEnrichmentDataset } from "../enrich/ip-dataset.js";
import { enrichIpsHandler } from "./enrich-ips.js";

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

const ds = IpEnrichmentDataset.fromCsv(
  ["1.2.3.0/24,US,Ashburn,AS14618,Example Cloud,true", "203.0.113.5,DE,Berlin,AS3320,Example ISP,false"].join("\n"),
);

describe("enrichIpsHandler (R6, issue #415 Gap B)", () => {
  it("returns a clear 'not configured' notice when no dataset is loaded", async () => {
    const out = parse(await enrichIpsHandler(null, { ips: ["1.2.3.4"] }));
    assert.match(out.error, /not configured/i);
    assert.match(out.error, /OMCP_IP_ENRICH_FILE/);
  });

  it("rejects empty / missing ips", async () => {
    assert.match(parse(await enrichIpsHandler(ds, { ips: [] })).error, /non-empty array/i);
    assert.match(parse(await enrichIpsHandler(ds, {})).error, /non-empty array/i);
  });

  it("rejects an over-large batch", async () => {
    const many = Array.from({ length: 1001 }, (_, i) => `1.2.3.${i % 255}`);
    assert.match(parse(await enrichIpsHandler(ds, { ips: many })).error, /Too many IPs/i);
  });

  it("enriches known IPs and reports found=false for misses + invalid", async () => {
    const out = parse(await enrichIpsHandler(ds, { ips: ["1.2.3.99", "8.8.8.8", "not-an-ip"] }));
    assert.equal(out.results.length, 3);

    const matched = out.results.find((r: any) => r.ip === "1.2.3.99");
    assert.equal(matched.found, true);
    assert.equal(matched.city, "Ashburn");
    assert.equal(matched.hosting, true);

    const miss = out.results.find((r: any) => r.ip === "8.8.8.8");
    assert.equal(miss.found, false);
    assert.equal(miss.city, undefined);

    const invalid = out.results.find((r: any) => r.ip === "not-an-ip");
    assert.equal(invalid.found, false);

    assert.deepEqual(out.summary, { total: 3, matched: 1, unmatched: 1, invalid: 1 });
    assert.equal(out.datasetSize, 2);
  });

  it("accepts IPv6 inputs and enriches them (not counted invalid)", async () => {
    const ds6 = IpEnrichmentDataset.fromCsv(
      ["2001:db8::/32,US,,AS14618,Example Cloud,true", "1.2.3.0/24,DE,Berlin,AS3320,Example ISP,false"].join("\n"),
    );
    const out = parse(await enrichIpsHandler(ds6, { ips: ["2001:db8::1", "2606:4700::1", "1.2.3.9"] }));
    const v6hit = out.results.find((r: any) => r.ip === "2001:db8::1");
    assert.equal(v6hit.found, true);
    assert.equal(v6hit.org, "Example Cloud");
    const v6miss = out.results.find((r: any) => r.ip === "2606:4700::1");
    assert.equal(v6miss.found, false);
    // A valid-but-unmatched IPv6 is "unmatched", NOT "invalid".
    assert.deepEqual(out.summary, { total: 3, matched: 2, unmatched: 1, invalid: 0 });
  });
});

describe("enrichIpsHandler — optional RDAP fallback (issue #477)", () => {
  // Minimal RdapResolver stub: returns a fixed hit for one IP, a true negative
  // otherwise, and records which IPs it was asked about (to prove CSV-first).
  // `transient` IPs resolve to a transient outcome (e.g. rate-limited) — #523.
  function rdapStub(
    hit: Record<string, { country?: string; org?: string }>,
    transient: Record<string, "rate_limited" | "timeout" | "upstream_error" | "network_error"> = {},
  ) {
    const asked: string[] = [];
    return {
      asked,
      resolver: {
        resolve: async (ip: string) => {
          asked.push(ip);
          if (transient[ip]) return { status: "transient", reason: transient[ip] };
          return hit[ip] ? { status: "ok", value: hit[ip] } : { status: "not_found" };
        },
      } as any,
    };
  }

  it("with no dataset but RDAP enabled → not 'not configured'; resolves via RDAP", async () => {
    const { resolver } = rdapStub({ "8.8.8.8": { country: "US", org: "Google LLC" } });
    const out = parse(await enrichIpsHandler(null, { ips: ["8.8.8.8", "203.0.113.9"] }, undefined, resolver));
    const hit = out.results.find((r: any) => r.ip === "8.8.8.8");
    assert.equal(hit.found, true);
    assert.equal(hit.via, "rdap");
    assert.equal(hit.org, "Google LLC");
    assert.equal(out.results.find((r: any) => r.ip === "203.0.113.9").found, false);
    assert.equal(out.summary.viaRdap, 1);
    assert.equal(out.rdapEnabled, true);
  });

  it("offline dataset is PREFERRED — RDAP is not consulted for a covered IP", async () => {
    const { asked, resolver } = rdapStub({ "1.2.3.9": { country: "XX", org: "should-not-be-used" } });
    const out = parse(await enrichIpsHandler(ds, { ips: ["1.2.3.9"] }, undefined, resolver));
    const hit = out.results.find((r: any) => r.ip === "1.2.3.9");
    assert.equal(hit.via, "dataset");
    assert.equal(hit.city, "Ashburn"); // from the CSV, not RDAP
    assert.deepEqual(asked, [], "RDAP must not be queried for a dataset-covered IP");
  });

  it("RDAP fills only the gaps the dataset didn't cover", async () => {
    const { asked, resolver } = rdapStub({ "9.9.9.9": { country: "US", org: "Quad9" } });
    const out = parse(await enrichIpsHandler(ds, { ips: ["1.2.3.9", "9.9.9.9"] }, undefined, resolver));
    assert.equal(out.results.find((r: any) => r.ip === "1.2.3.9").via, "dataset");
    assert.equal(out.results.find((r: any) => r.ip === "9.9.9.9").via, "rdap");
    assert.deepEqual(asked, ["9.9.9.9"], "RDAP queried only for the uncovered IP");
    assert.equal(out.summary.matched, 2);
    assert.equal(out.summary.viaRdap, 1);
  });

  it("no dataset and no RDAP → still 'not configured', and names both options", async () => {
    const out = parse(await enrichIpsHandler(null, { ips: ["8.8.8.8"] }));
    assert.match(out.error, /not configured/i);
    assert.match(out.error, /OMCP_IP_ENRICH_RDAP/);
  });

  // Issue #523: a rate-limited lookup must NOT masquerade as a confirmed negative.
  it("marks a rate-limited lookup transient (not a confirmed negative)", async () => {
    const { resolver } = rdapStub(
      { "8.8.8.8": { country: "US", org: "Google LLC" } },
      { "203.0.113.10": "rate_limited" },
    );
    const out = parse(await enrichIpsHandler(null, { ips: ["8.8.8.8", "203.0.113.10"] }, undefined, resolver));

    const hit = out.results.find((r: any) => r.ip === "8.8.8.8");
    assert.equal(hit.found, true);

    const throttled = out.results.find((r: any) => r.ip === "203.0.113.10");
    assert.equal(throttled.found, false);
    assert.equal(throttled.transient, true);
    assert.equal(throttled.error, "rate_limited");

    // The throttled IP is counted as transient, NOT folded into `unmatched`.
    assert.equal(out.summary.matched, 1);
    assert.equal(out.summary.transient, 1);
    assert.equal(out.summary.unmatched, 0);
    assert.match(out.note, /NOT confirmed negatives/i);
  });

  it("a genuine miss stays a clean negative — no transient marker, no note", async () => {
    const { resolver } = rdapStub({ "8.8.8.8": { country: "US", org: "Google LLC" } });
    const out = parse(await enrichIpsHandler(null, { ips: ["8.8.8.8", "203.0.113.9"] }, undefined, resolver));
    const miss = out.results.find((r: any) => r.ip === "203.0.113.9");
    assert.equal(miss.found, false);
    assert.equal(miss.transient, undefined);
    assert.equal(out.summary.transient, 0);
    assert.equal(out.note, undefined);
  });
});
