import { test } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, createPublicKey } from "node:crypto";

import { verifyIdToken, b64urlDecode, type Jwk, JwtVerifyError } from "./jwt.js";

function b64u(s: string | Buffer): string {
  const b = typeof s === "string" ? Buffer.from(s, "utf8") : s;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signRs256(payload: Record<string, unknown>, privateKey: import("node:crypto").KeyObject, kid: string): string {
  const header = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const body = b64u(JSON.stringify(payload));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  signer.end();
  const sig = b64u(signer.sign(privateKey));
  return `${header}.${body}.${sig}`;
}

function rsaKeypair(): { jwk: Jwk; privateKey: import("node:crypto").KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = createPublicKey(publicKey).export({ format: "jwk" }) as Jwk;
  jwk.kid = "test-key-1";
  return { jwk, privateKey };
}

test("b64urlDecode — round-trips standard and padded inputs", () => {
  assert.equal(b64urlDecode("AQ").toString("hex"), "01");
  assert.equal(b64urlDecode("-_-_").toString("hex"), "fbffbf");
});

test("verifyIdToken — happy path on RS256", () => {
  const { jwk, privateKey } = rsaKeypair();
  const now = 1_700_000_000;
  const payload = { iss: "https://idp.test", aud: "client-1", sub: "alice", exp: now + 60, iat: now, nonce: "n-1" };
  const jwt = signRs256(payload, privateKey, jwk.kid!);
  const out = verifyIdToken(jwt, [jwk], { issuer: "https://idp.test", audience: "client-1", nonce: "n-1", now: () => now * 1000 });
  assert.equal(out.sub, "alice");
});

test("verifyIdToken — rejects alg=none", () => {
  const header = b64u(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = b64u(JSON.stringify({ iss: "x", aud: "x", exp: 9_999_999_999 }));
  const jwt = `${header}.${body}.`;
  assert.throws(() => verifyIdToken(jwt, [], { issuer: "x", audience: "x" }), JwtVerifyError);
});

test("verifyIdToken — rejects unsupported alg (HS256)", () => {
  const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify({ iss: "x", aud: "x", exp: 9_999_999_999 }));
  const jwt = `${header}.${body}.AAAA`;
  assert.throws(() => verifyIdToken(jwt, [], { issuer: "x", audience: "x" }), /unsupported alg/);
});

test("verifyIdToken — rejects expired token (beyond clock skew)", () => {
  const { jwk, privateKey } = rsaKeypair();
  const now = 1_700_000_000;
  const jwt = signRs256({ iss: "https://idp.test", aud: "c", exp: now - 1000 }, privateKey, jwk.kid!);
  assert.throws(
    () => verifyIdToken(jwt, [jwk], { issuer: "https://idp.test", audience: "c", now: () => now * 1000 }),
    /expired/,
  );
});

test("verifyIdToken — rejects iss / aud / nonce mismatch", () => {
  const { jwk, privateKey } = rsaKeypair();
  const now = 1_700_000_000;
  const jwt = signRs256({ iss: "https://idp.test", aud: "c", exp: now + 60, nonce: "real" }, privateKey, jwk.kid!);
  assert.throws(() => verifyIdToken(jwt, [jwk], { issuer: "wrong", audience: "c", now: () => now * 1000 }), /iss mismatch/);
  assert.throws(() => verifyIdToken(jwt, [jwk], { issuer: "https://idp.test", audience: "wrong", now: () => now * 1000 }), /aud mismatch/);
  assert.throws(() => verifyIdToken(jwt, [jwk], { issuer: "https://idp.test", audience: "c", nonce: "other", now: () => now * 1000 }), /nonce mismatch/);
});

test("verifyIdToken — aud as array including expected", () => {
  const { jwk, privateKey } = rsaKeypair();
  const now = 1_700_000_000;
  const jwt = signRs256({ iss: "https://idp.test", aud: ["c", "other"], exp: now + 60 }, privateKey, jwk.kid!);
  const out = verifyIdToken(jwt, [jwk], { issuer: "https://idp.test", audience: "c", now: () => now * 1000 });
  assert.deepEqual(out.aud, ["c", "other"]);
});

test("verifyIdToken — bad signature is rejected", () => {
  const { jwk, privateKey } = rsaKeypair();
  const now = 1_700_000_000;
  const jwt = signRs256({ iss: "https://idp.test", aud: "c", exp: now + 60 }, privateKey, jwk.kid!);
  // Flip a bit in the signature segment
  const parts = jwt.split(".");
  const bad = parts[2].replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  const tampered = `${parts[0]}.${parts[1]}.${bad}`;
  assert.throws(
    () => verifyIdToken(tampered, [jwk], { issuer: "https://idp.test", audience: "c", now: () => now * 1000 }),
    /signature verification failed/,
  );
});

test("verifyIdToken — picks key by kid when JWKS has multiple", () => {
  const a = rsaKeypair(); a.jwk.kid = "k-a";
  const b = rsaKeypair(); b.jwk.kid = "k-b";
  const now = 1_700_000_000;
  const jwt = signRs256({ iss: "i", aud: "c", exp: now + 60 }, b.privateKey, "k-b");
  // Both keys in the JWKS — verifier should reach for k-b.
  const out = verifyIdToken(jwt, [a.jwk, b.jwk], { issuer: "i", audience: "c", now: () => now * 1000 });
  assert.equal(out.iss, "i");
});
