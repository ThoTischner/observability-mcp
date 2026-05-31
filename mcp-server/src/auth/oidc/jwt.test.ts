import { test } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, createPublicKey } from "node:crypto";

import { verifyIdToken, b64urlDecode, type Jwk, JwtVerifyError } from "./jwt.js";

function b64u(s: string | Buffer): string {
  const b = typeof s === "string" ? Buffer.from(s, "utf8") : s;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Sign with a PEM-encoded private key. PEM strings work identically
// across every Node version we ship on; raw KeyObject destructuring
// of generateKeyPairSync hit a "Invalid key object type public,
// expected private" error in CI's Node 20 (private/public swap
// somewhere in the destructure result). PEM avoids the whole class.
function signRs256(payload: Record<string, unknown>, privateKeyPem: string, kid: string): string {
  const header = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const body = b64u(JSON.stringify(payload));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  signer.end();
  const sig = b64u(signer.sign(privateKeyPem));
  return `${header}.${body}.${sig}`;
}

function rsaKeypair(): { jwk: Jwk; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const jwk = createPublicKey(publicKey).export({ format: "jwk" }) as Jwk;
  jwk.kid = "test-key-1";
  return { jwk, privateKeyPem: privateKey };
}

test("b64urlDecode — round-trips standard and padded inputs", () => {
  assert.equal(b64urlDecode("AQ").toString("hex"), "01");
  assert.equal(b64urlDecode("-_-_").toString("hex"), "fbffbf");
});

test("verifyIdToken — happy path on RS256", () => {
  const { jwk, privateKeyPem } = rsaKeypair();
  const now = 1_700_000_000;
  const payload = { iss: "https://idp.test", aud: "client-1", sub: "alice", exp: now + 60, iat: now, nonce: "n-1" };
  const jwt = signRs256(payload, privateKeyPem, jwk.kid!);
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
  const { jwk, privateKeyPem } = rsaKeypair();
  const now = 1_700_000_000;
  const jwt = signRs256({ iss: "https://idp.test", aud: "c", exp: now - 1000 }, privateKeyPem, jwk.kid!);
  assert.throws(
    () => verifyIdToken(jwt, [jwk], { issuer: "https://idp.test", audience: "c", now: () => now * 1000 }),
    /expired/,
  );
});

test("verifyIdToken — rejects iss / aud / nonce mismatch", () => {
  const { jwk, privateKeyPem } = rsaKeypair();
  const now = 1_700_000_000;
  const jwt = signRs256({ iss: "https://idp.test", aud: "c", exp: now + 60, nonce: "real" }, privateKeyPem, jwk.kid!);
  assert.throws(() => verifyIdToken(jwt, [jwk], { issuer: "wrong", audience: "c", now: () => now * 1000 }), /iss mismatch/);
  assert.throws(() => verifyIdToken(jwt, [jwk], { issuer: "https://idp.test", audience: "wrong", now: () => now * 1000 }), /aud mismatch/);
  assert.throws(() => verifyIdToken(jwt, [jwk], { issuer: "https://idp.test", audience: "c", nonce: "other", now: () => now * 1000 }), /nonce mismatch/);
});

test("verifyIdToken — aud as array including expected", () => {
  const { jwk, privateKeyPem } = rsaKeypair();
  const now = 1_700_000_000;
  const jwt = signRs256({ iss: "https://idp.test", aud: ["c", "other"], exp: now + 60 }, privateKeyPem, jwk.kid!);
  const out = verifyIdToken(jwt, [jwk], { issuer: "https://idp.test", audience: "c", now: () => now * 1000 });
  assert.deepEqual(out.aud, ["c", "other"]);
});

test("verifyIdToken — bad signature is rejected", () => {
  const { jwk, privateKeyPem } = rsaKeypair();
  const now = 1_700_000_000;
  const jwt = signRs256({ iss: "https://idp.test", aud: "c", exp: now + 60 }, privateKeyPem, jwk.kid!);
  // Flip a bit in the signature segment
  const parts = jwt.split(".");
  const bad = parts[2].replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  const tampered = `${parts[0]}.${parts[1]}.${bad}`;
  assert.throws(
    () => verifyIdToken(tampered, [jwk], { issuer: "https://idp.test", audience: "c", now: () => now * 1000 }),
    /signature verification failed/,
  );
});

test("verifyIdToken — happy path on ES256 (P-256 EC key)", () => {
  // PEM-encode for the same Node-version-stability reason as RS256
  // above.
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const jwk = createPublicKey(publicKey).export({ format: "jwk" }) as Jwk;
  jwk.kid = "ec-key-1";
  const now = 1_700_000_000;
  const header = b64u(JSON.stringify({ alg: "ES256", typ: "JWT", kid: jwk.kid }));
  const body = b64u(JSON.stringify({ iss: "https://idp.test", aud: "client-1", sub: "bob", exp: now + 60 }));
  // Node's default ECDSA signature is DER; convert to raw R||S 64-byte
  // ieee-p1363 for JWS spec compliance.
  const signer = createSign("SHA256");
  signer.update(`${header}.${body}`);
  signer.end();
  const sig = signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  assert.equal(sig.length, 64, "ES256 raw signature must be 64 bytes");
  const jwt = `${header}.${body}.${b64u(sig)}`;
  const out = verifyIdToken(jwt, [jwk], { issuer: "https://idp.test", audience: "client-1", now: () => now * 1000 });
  assert.equal(out.sub, "bob");
});

test("verifyIdToken — strict kid match: header kid does not silently match kid-less JWK", () => {
  const { jwk, privateKeyPem } = rsaKeypair();
  // JWK with NO kid in the keyset
  const untagged: Jwk = { ...jwk };
  delete untagged.kid;
  const now = 1_700_000_000;
  // Token claims kid=ghost — JWK doesn't have one, must reject.
  const jwt = signRs256({ iss: "i", aud: "c", exp: now + 60 }, privateKeyPem, "ghost-kid");
  assert.throws(
    () => verifyIdToken(jwt, [untagged], { issuer: "i", audience: "c", now: () => now * 1000 }),
    /no JWK matches kid=ghost-kid/,
  );
});

test("verifyIdToken — picks key by kid when JWKS has multiple", () => {
  const a = rsaKeypair(); a.jwk.kid = "k-a";
  const b = rsaKeypair(); b.jwk.kid = "k-b";
  const now = 1_700_000_000;
  const jwt = signRs256({ iss: "i", aud: "c", exp: now + 60 }, b.privateKeyPem, "k-b");
  // Both keys in the JWKS — verifier should reach for k-b.
  const out = verifyIdToken(jwt, [a.jwk, b.jwk], { issuer: "i", audience: "c", now: () => now * 1000 });
  assert.equal(out.iss, "i");
});
