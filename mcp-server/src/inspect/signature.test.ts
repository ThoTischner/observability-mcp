import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveSignature,
  countBucket,
  durationToSeconds,
  durationBucket,
  numBucket,
  queryFingerprint,
} from "./signature.js";

describe("buckets", () => {
  it("countBucket bands", () => {
    assert.equal(countBucket(0), "1");
    assert.equal(countBucket(1), "1");
    assert.equal(countBucket(7), "2-10");
    assert.equal(countBucket(50), "11-100");
    assert.equal(countBucket(900), "101-1000");
    assert.equal(countBucket(5000), ">1000");
  });

  it("durationToSeconds parses prom/loki durations", () => {
    assert.equal(durationToSeconds("5m"), 300);
    assert.equal(durationToSeconds("1h"), 3600);
    assert.equal(durationToSeconds("1h30m"), 5400);
    assert.equal(durationToSeconds("2d"), 172800);
    assert.equal(durationToSeconds("250ms"), 0.25);
  });

  it("durationToSeconds rejects non-durations", () => {
    assert.equal(durationToSeconds("not-a-duration"), null);
    assert.equal(durationToSeconds("100"), null);
    assert.equal(durationToSeconds(""), null);
  });

  it("durationBucket bands + 'other' for junk", () => {
    assert.equal(durationBucket("30s"), "<=5m");
    assert.equal(durationBucket("45m"), "<=1h");
    assert.equal(durationBucket("12h"), "<=1d");
    assert.equal(durationBucket("7d"), ">1d");
    assert.equal(durationBucket("garbage"), "other");
  });

  it("numBucket bands", () => {
    assert.equal(numBucket(5), "<=10");
    assert.equal(numBucket(50), "<=100");
    assert.equal(numBucket(500), "<=1000");
    assert.equal(numBucket(9999), ">1000");
  });
});

describe("queryFingerprint", () => {
  it("blank → empty", () => {
    assert.equal(queryFingerprint(""), "empty");
    assert.equal(queryFingerprint("   "), "empty");
  });
  it("extracts func + metric + label from a PromQL rate query", () => {
    const fp = queryFingerprint('rate(http_requests_total{job="api"}[5m])');
    assert.match(fp, /f:rate/);
    assert.match(fp, /m:http_requests_total/);
    assert.match(fp, /l:job/);
    // the range fragment "m" and the quoted value "api" are NOT metrics
    assert.ok(!/[, ]m[, ]|m:.*\bm\b/.test(fp.replace("http_requests_total", "")));
    assert.ok(!fp.includes("api"));
  });
  it("treats by()-grouping labels as labels, not metrics", () => {
    const fp = queryFingerprint("sum by (instance) (up)");
    assert.match(fp, /f:sum/);
    assert.match(fp, /m:up/);
    assert.match(fp, /l:instance/);
  });
  it("LogQL stream selector → label keys", () => {
    const fp = queryFingerprint('{service_name="payment", level="error"} |= "boom"');
    assert.match(fp, /l:level,service_name/);
    assert.ok(!fp.includes("payment") && !fp.includes("boom"));
  });
  it("is deterministic + sorted + capped", () => {
    const a = queryFingerprint('sum(rate(a_total[1m])) + avg(b_total)');
    const b = queryFingerprint('avg(b_total) + sum(rate(a_total[1m]))');
    assert.equal(a, b);
    assert.match(a, /f:avg,rate,sum/);
    assert.match(a, /m:a_total,b_total/);
  });
  it("is fast on a huge attacker-supplied query (no ReDoS)", () => {
    const t0 = Date.now();
    queryFingerprint("a".repeat(100000));
    queryFingerprint("(".repeat(50000));
    queryFingerprint("rate(".repeat(20000));
    assert.ok(Date.now() - t0 < 100, "fingerprint stays linear/bounded on large input");
  });
  it("non-query free text with no structure → present", () => {
    assert.equal(queryFingerprint("just some words"), "m:just,some,words"); // bare idents count as metrics
    assert.equal(queryFingerprint("!!!"), "present");
  });
});

describe("deriveSignature query fingerprinting", () => {
  it("query/expr keys get a fingerprint, not 'present'", () => {
    const sig = deriveSignature("query_metrics", { service: "pay", query: 'rate(http_requests_total[5m])' });
    assert.match(sig.argShape.query, /m:http_requests_total/);
    assert.match(sig.argShape.query, /f:rate/);
  });
  it("non-query free text still collapses to 'present'", () => {
    const sig = deriveSignature("x", { note: "hello world" });
    assert.equal(sig.argShape.note, "present");
  });
});

describe("deriveSignature", () => {
  it("lifts source/service/namespace as real resource dimensions", () => {
    const sig = deriveSignature("query_logs", { source: "prom-eu", service: "payment", namespace: "omcp" });
    assert.equal(sig.source, "prom-eu");
    assert.equal(sig.service, "payment");
    assert.equal(sig.namespace, "omcp");
  });

  it("buckets array length, never keeps elements", () => {
    const sig = deriveSignature("enrich_ips", { ips: ["1.2.3.4", "5.6.7.8", "9.9.9.9"] });
    assert.equal(sig.argShape.ips, "n=2-10");
    assert.ok(!("source" in sig));
  });

  it("buckets duration-shaped keys, fingerprints queries (literal never kept)", () => {
    const sig = deriveSignature("query_metrics", { query: "rate(http_requests_total[5m])", window: "1h", limit: 500 });
    assert.match(sig.argShape.query, /m:http_requests_total/); // structural, not the literal
    assert.ok(!sig.argShape.query.includes("[5m]"));
    assert.equal(sig.argShape.window, "<=1h");
    assert.equal(sig.argShape.limit, "<=1000");
  });

  it("handles booleans, empty strings, nested objects, and non-objects", () => {
    const sig = deriveSignature("x", { flag: true, empty: "", nested: { a: 1 } });
    assert.equal(sig.argShape.flag, "true");
    assert.equal(sig.argShape.empty, "empty");
    assert.equal(sig.argShape.nested, "object");
    assert.deepEqual(deriveSignature("x", null), { argShape: {} });
    assert.deepEqual(deriveSignature("x", "str"), { argShape: {} });
  });

  it("drops prototype-polluting arg keys (__proto__/constructor/prototype)", () => {
    const sig = deriveSignature("x", JSON.parse('{"__proto__":"p","constructor":"c","prototype":"q","ok":5}'));
    const keys = Object.keys(sig.argShape);
    assert.ok(!keys.includes("__proto__"));
    assert.ok(!keys.includes("constructor"));
    assert.ok(!keys.includes("prototype"));
    assert.equal(sig.argShape.ok, "<=10");
    // prototype not polluted
    assert.equal(({} as Record<string, unknown>).p, undefined);
  });

  it("is deterministic", () => {
    const a = deriveSignature("query_logs", { source: "s", service: "v", limit: 5, window: "5m" });
    const b = deriveSignature("query_logs", { window: "5m", limit: 5, service: "v", source: "s" });
    assert.deepEqual(a, b);
  });
});
