import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { parseTtlSeconds, parseArgs, mint } from "./mint.mjs";
import { verifyEntitlement, hasFeature } from "./entitlement.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const NOW = 1_700_000_000;

test("parseTtlSeconds handles s/m/h/d and rejects junk", () => {
  assert.equal(parseTtlSeconds("30s"), 30);
  assert.equal(parseTtlSeconds("5m"), 300);
  assert.equal(parseTtlSeconds("2h"), 7200);
  assert.equal(parseTtlSeconds("365d"), 365 * 86400);
  assert.throws(() => parseTtlSeconds("1w"), /invalid --ttl/);
  assert.throws(() => parseTtlSeconds("abc"), /invalid --ttl/);
});

test("parseArgs reads flags, splits features, defaults tier/ttl", () => {
  const a = parseArgs(["--sub", "org-acme", "--features", "access-control, audit ", "--key", "k.pem"]);
  assert.equal(a.sub, "org-acme");
  assert.deepEqual(a.features, ["access-control", "audit"]);
  assert.equal(a.tier, "enterprise");
  assert.equal(a.ttl, "365d");
  assert.equal(a.key, "k.pem");
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
});

test("mint requires sub and at least one feature", () => {
  assert.throws(() => mint({ features: ["x"], ttlSeconds: 10, privateKey }), /--sub is required/);
  assert.throws(() => mint({ sub: "o", features: [], ttlSeconds: 10, privateKey }), /--features is required/);
});

test("a minted token verifies and carries the requested claims", () => {
  const token = mint(
    { sub: "org-acme", tier: "enterprise", features: ["access-control", "audit"], ttlSeconds: 3600, privateKey },
    NOW
  );
  const r = verifyEntitlement(token, publicKey, { now: () => NOW + 60 });
  assert.equal(r.valid, true);
  assert.equal(r.claims.sub, "org-acme");
  assert.equal(r.claims.iat, NOW);
  assert.equal(r.claims.exp, NOW + 3600);
  assert.equal(hasFeature(r.claims, "access-control"), true);
  assert.equal(hasFeature(r.claims, "catalog"), false);
});

test("a minted token is expired once past its ttl (round-trip)", () => {
  const token = mint({ sub: "o", features: ["audit"], ttlSeconds: 100, privateKey }, NOW);
  assert.equal(verifyEntitlement(token, publicKey, { now: () => NOW + 50 }).valid, true);
  const late = verifyEntitlement(token, publicKey, { now: () => NOW + 200 });
  assert.equal(late.valid, false);
  assert.match(late.reason, /expired/);
});
