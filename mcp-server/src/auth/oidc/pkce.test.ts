import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { base64url, generateCodeVerifier, challengeFromVerifier, generatePkcePair } from "./pkce.js";

test("base64url — strips padding and rewrites +/", () => {
  // Buffer that hits + and / under standard base64 encoding
  const b = Buffer.from([0xfb, 0xff, 0xbf]);
  assert.equal(b.toString("base64"), "+/+/"); // sanity
  assert.equal(base64url(b), "-_-_");
  // Padding case
  assert.equal(base64url(Buffer.from([0x01])), "AQ");
});

test("generateCodeVerifier — only unreserved chars, length 64", () => {
  const v = generateCodeVerifier();
  assert.equal(v.length, 64);
  assert.match(v, /^[A-Za-z0-9\-._~]+$/);
});

test("generateCodeVerifier — two calls produce distinct values", () => {
  const a = generateCodeVerifier();
  const b = generateCodeVerifier();
  assert.notEqual(a, b);
});

test("challengeFromVerifier — matches base64url(sha256(verifier))", () => {
  const v = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"; // RFC 7636 §4.4 sample
  const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"; // RFC 7636 §4.4
  assert.equal(challengeFromVerifier(v), expected);
});

test("challengeFromVerifier — deterministic", () => {
  const v = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789--__";
  assert.equal(challengeFromVerifier(v), challengeFromVerifier(v));
});

test("generatePkcePair — challenge matches S256(verifier) and method is S256", () => {
  const p = generatePkcePair();
  const expect = Buffer.from(createHash("sha256").update(p.verifier).digest()).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(p.challenge, expect);
  assert.equal(p.method, "S256");
});
