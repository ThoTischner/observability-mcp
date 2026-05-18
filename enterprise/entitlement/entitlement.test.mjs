import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import {
  signEntitlement,
  verifyEntitlement,
  hasFeature,
  requireFeature,
  canonical,
  EntitlementError,
} from "./entitlement.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const { publicKey: otherPub } = generateKeyPairSync("ed25519");

const T0 = 1_700_000_000; // fixed "now"
const clock = (t = T0) => () => t;

function token(over = {}) {
  // canonical() sorts keys, so payload object key order here is irrelevant.
  const payload = { sub: "org-acme", tier: "enterprise", features: ["rbac", "audit"], iat: T0 - 10, exp: T0 + 3600, ...over };
  return signEntitlement(payload, privateKey);
}

test("canonical produces stable, recursively-sorted JSON", () => {
  assert.equal(canonical({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});

test("a freshly signed token verifies and returns claims", () => {
  const r = verifyEntitlement(token(), publicKey, { now: clock() });
  assert.equal(r.valid, true);
  assert.equal(r.claims.sub, "org-acme");
  assert.deepEqual(r.claims.features, ["rbac", "audit"]);
});

test("wrong public key → signature mismatch (default-deny)", () => {
  const r = verifyEntitlement(token(), otherPub, { now: clock() });
  assert.equal(r.valid, false);
  assert.match(r.reason, /signature mismatch/);
});

test("tampering the payload after signing is rejected", () => {
  const t = token();
  const [p, s] = t.split(".");
  const claims = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  claims.features.push("entitlement"); // privilege escalation attempt
  const forgedPayload = Buffer.from(JSON.stringify(claims)).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const r = verifyEntitlement(`${forgedPayload}.${s}`, publicKey, { now: clock() });
  assert.equal(r.valid, false); // sig no longer matches the changed bytes
});

test("expired token is denied", () => {
  const r = verifyEntitlement(token({ exp: T0 - 1 }), publicKey, { now: clock() });
  assert.equal(r.valid, false);
  assert.match(r.reason, /expired/);
});

test("not-yet-valid token (iat in the future beyond skew) is denied", () => {
  const r = verifyEntitlement(token({ iat: T0 + 1000 }), publicKey, { now: clock(), skew: 60 });
  assert.equal(r.valid, false);
  assert.match(r.reason, /not yet valid/);
});

test("iat within skew window is accepted", () => {
  const r = verifyEntitlement(token({ iat: T0 + 30 }), publicKey, { now: clock(), skew: 60 });
  assert.equal(r.valid, true);
});

test("malformed tokens are denied, never thrown", () => {
  for (const bad of ["", "no-dot", "a.b.c", ".", "x.", ".y", 42, null]) {
    const r = verifyEntitlement(bad, publicKey, { now: clock() });
    assert.equal(r.valid, false);
  }
});

test("non-canonical payload encoding is rejected even if signature is valid", () => {
  // Sign deliberately non-canonical JSON bytes (keys unsorted) → the
  // signature is valid for those bytes but verify must reject the shape.
  const raw = Buffer.from('{"b":2,"a":1}', "utf8");
  const sig = edSign(null, raw, privateKey);
  const b = (x) => Buffer.from(x).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const r = verifyEntitlement(`${b(raw)}.${b(sig)}`, publicKey, { now: clock() });
  assert.equal(r.valid, false);
  assert.match(r.reason, /canonical/);
});

test("hasFeature honours explicit list and the '*' wildcard", () => {
  assert.equal(hasFeature({ features: ["rbac"] }, "rbac"), true);
  assert.equal(hasFeature({ features: ["rbac"] }, "audit"), false);
  assert.equal(hasFeature({ features: ["*"] }, "anything"), true);
  assert.equal(hasFeature({}, "x"), false);
  assert.equal(hasFeature(null, "x"), false);
});

test("requireFeature returns claims when entitled", () => {
  const claims = requireFeature(token(), publicKey, "audit", { now: clock() });
  assert.equal(claims.sub, "org-acme");
});

test("requireFeature throws EntitlementError when token invalid", () => {
  assert.throws(
    () => requireFeature(token({ exp: T0 - 1 }), publicKey, "rbac", { now: clock() }),
    (e) => e instanceof EntitlementError && e.code === "ENTITLEMENT_DENIED" && /expired/.test(e.reason)
  );
});

test("requireFeature throws when the feature is not entitled", () => {
  assert.throws(
    () => requireFeature(token({ features: ["rbac"] }), publicKey, "catalog", { now: clock() }),
    (e) => e instanceof EntitlementError && /feature 'catalog' not entitled/.test(e.reason)
  );
});

test("a wildcard token entitles every feature", () => {
  const claims = requireFeature(token({ features: ["*"] }), publicKey, "entitlement", { now: clock() });
  assert.ok(claims);
});
