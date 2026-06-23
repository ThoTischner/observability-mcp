import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRdapResponse, RdapResolver, type FetchLike } from "./rdap.js";

// A realistic RDAP IP-network response (trimmed). org comes from the
// registrant entity's jCard fn; country is top-level.
const RDAP_GOOGLE = {
  handle: "GOGL",
  name: "GOGL",
  country: "US",
  entities: [
    { roles: ["registrant"], vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Google LLC"]]] },
  ],
};

describe("parseRdapResponse", () => {
  it("extracts country + org (entity fn preferred over name)", () => {
    assert.deepEqual(parseRdapResponse(RDAP_GOOGLE), { country: "US", org: "Google LLC" });
  });
  it("falls back to network `name` when no entity fn", () => {
    assert.deepEqual(parseRdapResponse({ country: "DE", name: "DTAG" }), { country: "DE", org: "DTAG" });
  });
  it("returns null when neither country nor org is present", () => {
    assert.equal(parseRdapResponse({ handle: "x" }), null);
    assert.equal(parseRdapResponse(null), null);
    assert.equal(parseRdapResponse("nope"), null);
  });
});

function stubFetch(handler: (url: string) => { ok: boolean; status: number; body: unknown }): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const r = handler(url);
    return { ok: r.ok, status: r.status, json: async () => r.body };
  };
  return { fetch, calls };
}

describe("RdapResolver", () => {
  it("looks up an IP and parses the response", async () => {
    const { fetch, calls } = stubFetch(() => ({ ok: true, status: 200, body: RDAP_GOOGLE }));
    const r = new RdapResolver({ fetch });
    assert.deepEqual(await r.lookup("8.8.8.8"), { country: "US", org: "Google LLC" });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/ip\/8\.8\.8\.8$/);
  });

  it("caches a hit — second lookup does not re-fetch", async () => {
    const { fetch, calls } = stubFetch(() => ({ ok: true, status: 200, body: RDAP_GOOGLE }));
    const r = new RdapResolver({ fetch });
    await r.lookup("8.8.8.8");
    await r.lookup("8.8.8.8");
    assert.equal(calls.length, 1, "second lookup served from cache");
  });

  it("caches a negative result (miss) too", async () => {
    const { fetch, calls } = stubFetch(() => ({ ok: false, status: 404, body: {} }));
    const r = new RdapResolver({ fetch });
    assert.equal(await r.lookup("203.0.113.7"), null);
    assert.equal(await r.lookup("203.0.113.7"), null);
    assert.equal(calls.length, 1, "negative result cached");
  });

  it("re-fetches after the TTL expires", async () => {
    const { fetch, calls } = stubFetch(() => ({ ok: true, status: 200, body: RDAP_GOOGLE }));
    const r = new RdapResolver({ fetch, ttlMs: 1000 });
    let t = 1000; r.now = () => t;
    await r.lookup("8.8.8.8");
    t = 2001; // past TTL
    await r.lookup("8.8.8.8");
    assert.equal(calls.length, 2, "expired entry re-fetched");
  });

  it("returns null for an invalid IP WITHOUT making a request", async () => {
    const { fetch, calls } = stubFetch(() => ({ ok: true, status: 200, body: RDAP_GOOGLE }));
    const r = new RdapResolver({ fetch });
    assert.equal(await r.lookup("not-an-ip"), null);
    assert.equal(calls.length, 0, "no network call for an invalid IP");
  });

  it("never throws on a fetch error — returns null", async () => {
    const r = new RdapResolver({ fetch: (async () => { throw new Error("network down"); }) as FetchLike });
    assert.equal(await r.lookup("8.8.8.8"), null);
  });
});

// Issue #523: a rate-limit / upstream failure must be distinguishable from a
// true negative, and must NOT poison the cache as one.
describe("RdapResolver.resolve — transient vs true negative (#523)", () => {
  const noSleep = async () => {};

  it("maps a 200 hit to ok", async () => {
    const { fetch } = stubFetch(() => ({ ok: true, status: 200, body: RDAP_GOOGLE }));
    const r = new RdapResolver({ fetch, sleep: noSleep });
    assert.deepEqual(await r.resolve("8.8.8.8"), { status: "ok", value: { country: "US", org: "Google LLC" } });
  });

  it("maps a 404 to a true negative (not_found)", async () => {
    const { fetch } = stubFetch(() => ({ ok: false, status: 404, body: {} }));
    const r = new RdapResolver({ fetch, sleep: noSleep });
    assert.deepEqual(await r.resolve("203.0.113.7"), { status: "not_found" });
  });

  it("maps a 200 with no country/org to not_found, not a bogus hit", async () => {
    const { fetch } = stubFetch(() => ({ ok: true, status: 200, body: { handle: "x" } }));
    const r = new RdapResolver({ fetch, sleep: noSleep });
    assert.deepEqual(await r.resolve("203.0.113.8"), { status: "not_found" });
  });

  it("maps a 429 to transient:rate_limited after exhausting retries", async () => {
    const { fetch, calls } = stubFetch(() => ({ ok: false, status: 429, body: {} }));
    const r = new RdapResolver({ fetch, sleep: noSleep, maxRetries: 2 });
    assert.deepEqual(await r.resolve("203.0.113.10"), { status: "transient", reason: "rate_limited" });
    assert.equal(calls.length, 3, "1 initial + 2 retries");
  });

  it("maps a 5xx to transient:upstream_error", async () => {
    const { fetch } = stubFetch(() => ({ ok: false, status: 503, body: {} }));
    const r = new RdapResolver({ fetch, sleep: noSleep, maxRetries: 0 });
    assert.deepEqual(await r.resolve("203.0.113.11"), { status: "transient", reason: "upstream_error" });
  });

  it("maps a thrown network error to transient:network_error", async () => {
    const r = new RdapResolver({ fetch: (async () => { throw new Error("ECONNRESET"); }) as FetchLike, sleep: noSleep, maxRetries: 0 });
    assert.deepEqual(await r.resolve("8.8.8.8"), { status: "transient", reason: "network_error" });
  });

  it("does NOT cache a transient failure — a later success resolves", async () => {
    let mode: "throttle" | "ok" = "throttle";
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      return mode === "throttle"
        ? { ok: false, status: 429, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => RDAP_GOOGLE };
    };
    const r = new RdapResolver({ fetch, sleep: noSleep, maxRetries: 0 });
    assert.deepEqual(await r.resolve("8.8.8.8"), { status: "transient", reason: "rate_limited" });
    mode = "ok";
    assert.deepEqual(await r.resolve("8.8.8.8"), { status: "ok", value: { country: "US", org: "Google LLC" } });
    assert.equal(calls.length, 2, "transient was not cached, so the retry re-fetched");
  });

  it("retries a transient then succeeds, returning ok", async () => {
    let n = 0;
    const fetch: FetchLike = async () => {
      n++;
      return n === 1
        ? { ok: false, status: 429, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => RDAP_GOOGLE };
    };
    const r = new RdapResolver({ fetch, sleep: noSleep, maxRetries: 2 });
    assert.deepEqual(await r.resolve("8.8.8.8"), { status: "ok", value: { country: "US", org: "Google LLC" } });
    assert.equal(n, 2, "succeeded on the first retry");
  });

  it("honors a numeric Retry-After for backoff (capped)", async () => {
    const slept: number[] = [];
    let n = 0;
    const fetch: FetchLike = async () => {
      n++;
      if (n === 1) return { ok: false, status: 429, json: async () => ({}), headers: { get: (h) => (h.toLowerCase() === "retry-after" ? "2" : null) } };
      return { ok: true, status: 200, json: async () => RDAP_GOOGLE };
    };
    const r = new RdapResolver({ fetch, sleep: async (ms) => { slept.push(ms); }, maxRetries: 1 });
    await r.resolve("8.8.8.8");
    assert.deepEqual(slept, [2000], "waited the Retry-After delta (2s) before retrying");
  });

  it("caches a true negative (no re-fetch within negTtl)", async () => {
    const { fetch, calls } = stubFetch(() => ({ ok: false, status: 404, body: {} }));
    const r = new RdapResolver({ fetch, sleep: noSleep });
    await r.resolve("203.0.113.7");
    await r.resolve("203.0.113.7");
    assert.equal(calls.length, 1, "negative cached");
  });
});
