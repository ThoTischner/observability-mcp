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
