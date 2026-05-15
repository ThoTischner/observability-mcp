import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign, createPublicKey } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  sha256Integrity,
  verifyIntegrity,
  verifyManifestSignature,
  loadTrustRoot,
  PluginVerificationError,
} from "./verify.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "verify-"));
}

test("sha256Integrity produces sha256-<base64> and round-trips", () => {
  const digest = sha256Integrity(Buffer.from("hello"));
  assert.match(digest, /^sha256-[A-Za-z0-9+/]+=*$/);
  assert.equal(sha256Integrity(Buffer.from("hello")), digest);
  assert.notEqual(sha256Integrity(Buffer.from("hellp")), digest);
});

test("verifyIntegrity passes on match, throws on mismatch and missing", () => {
  const dir = tmp();
  const entry = join(dir, "index.js");
  writeFileSync(entry, "export default () => ({});\n");
  const good = sha256Integrity(Buffer.from("export default () => ({});\n"));
  assert.doesNotThrow(() => verifyIntegrity(entry, good));
  assert.throws(() => verifyIntegrity(entry, "sha256-AAAA"), PluginVerificationError);
  assert.throws(() => verifyIntegrity(entry, undefined), PluginVerificationError);
  assert.throws(() => verifyIntegrity(join(dir, "nope.js"), good), PluginVerificationError);
});

test("Ed25519: valid signature verifies, tampered manifest is rejected", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const manifest = Buffer.from('{"name":"prometheus","schemaVersion":1}');
  const sig = cryptoSign(null, manifest, privateKey);
  assert.doesNotThrow(() => verifyManifestSignature(manifest, sig, publicKey));
  // base64-armored signature (the form `openssl ... | base64` emits)
  const armored = Buffer.from(sig.toString("base64"));
  assert.doesNotThrow(() => verifyManifestSignature(manifest, armored, publicKey));
  // tampered bytes
  assert.throws(
    () => verifyManifestSignature(Buffer.from('{"name":"evil"}'), sig, publicKey),
    PluginVerificationError
  );
});

test("RSA trust root path (algorithm=sha256) verifies", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const manifest = Buffer.from('{"name":"loki"}');
  const sig = cryptoSign("sha256", manifest, privateKey);
  assert.doesNotThrow(() => verifyManifestSignature(manifest, sig, publicKey));
});

test("signature from a different key is rejected", () => {
  const a = generateKeyPairSync("ed25519");
  const b = generateKeyPairSync("ed25519");
  const manifest = Buffer.from("payload");
  const sig = cryptoSign(null, manifest, a.privateKey);
  assert.throws(
    () => verifyManifestSignature(manifest, sig, b.publicKey),
    PluginVerificationError
  );
});

test("loadTrustRoot parses PEM and rejects garbage", () => {
  const dir = tmp();
  const { publicKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const p = join(dir, "trust.pem");
  writeFileSync(p, pem);
  const loaded = loadTrustRoot(p);
  assert.equal(
    loaded.export({ type: "spki", format: "pem" }),
    createPublicKey(pem).export({ type: "spki", format: "pem" })
  );
  const bad = join(dir, "bad.pem");
  writeFileSync(bad, "not a key");
  assert.throws(() => loadTrustRoot(bad), PluginVerificationError);
  assert.throws(() => loadTrustRoot(join(dir, "missing.pem")), PluginVerificationError);
});
