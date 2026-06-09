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
  it("returns a clear 'not configured' notice when no dataset is loaded", () => {
    const out = parse(enrichIpsHandler(null, { ips: ["1.2.3.4"] }));
    assert.match(out.error, /not configured/i);
    assert.match(out.error, /OMCP_IP_ENRICH_FILE/);
  });

  it("rejects empty / missing ips", () => {
    assert.match(parse(enrichIpsHandler(ds, { ips: [] })).error, /non-empty array/i);
    assert.match(parse(enrichIpsHandler(ds, {})).error, /non-empty array/i);
  });

  it("rejects an over-large batch", () => {
    const many = Array.from({ length: 1001 }, (_, i) => `1.2.3.${i % 255}`);
    assert.match(parse(enrichIpsHandler(ds, { ips: many })).error, /Too many IPs/i);
  });

  it("enriches known IPs and reports found=false for misses + invalid", () => {
    const out = parse(enrichIpsHandler(ds, { ips: ["1.2.3.99", "8.8.8.8", "not-an-ip"] }));
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
});
