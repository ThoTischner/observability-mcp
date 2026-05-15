import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

// Airgapped-friendly plugin verification.
//
// No network, no external binary (no cosign): a plugin is trusted when
//   1. its entry file hashes to the manifest's `integrity` digest, and
//   2. the manifest bytes carry a detached signature that verifies
//      against a locally-configured trust-root public key.
//
// Ed25519 and RSA/EC (PKCS#8 / SPKI PEM) trust roots are supported.

export class PluginVerificationError extends Error {}

/** Parse a PEM public key into a KeyObject. Throws PluginVerificationError. */
export function loadTrustRoot(pemPath: string): KeyObject {
  let pem: string;
  try {
    pem = readFileSync(pemPath, "utf8");
  } catch (err) {
    throw new PluginVerificationError(`trust root unreadable at ${pemPath}: ${String(err)}`);
  }
  try {
    return createPublicKey(pem);
  } catch (err) {
    throw new PluginVerificationError(`trust root is not a valid PEM public key: ${String(err)}`);
  }
}

/** "sha256-<base64>" digest of a buffer, matching the manifest `integrity` form. */
export function sha256Integrity(data: Buffer): string {
  return "sha256-" + createHash("sha256").update(data).digest("base64");
}

/**
 * Constant-time-ish compare of the entry file against the manifest's
 * declared integrity digest. Throws on mismatch.
 */
export function verifyIntegrity(entryPath: string, integrity: string | undefined): void {
  if (!integrity) {
    throw new PluginVerificationError("manifest has no integrity digest");
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(entryPath);
  } catch (err) {
    throw new PluginVerificationError(`entry file unreadable: ${String(err)}`);
  }
  const actual = sha256Integrity(bytes);
  if (actual.length !== integrity.length || actual !== integrity) {
    throw new PluginVerificationError(
      `entry file integrity mismatch (manifest=${integrity} actual=${actual})`
    );
  }
}

/**
 * Verify a detached signature over the raw manifest bytes against the
 * trust root. Signature is read as base64 (whitespace tolerated, e.g. a
 * `manifest.json.sig` produced by `openssl dgst -sign ... | base64`).
 * Throws PluginVerificationError if the signature does not verify.
 */
export function verifyManifestSignature(
  manifestBytes: Buffer,
  signatureBytes: Buffer,
  trustRoot: KeyObject
): void {
  const sig = decodeSignature(signatureBytes);
  // Ed25519/Ed448 take algorithm=null; RSA/EC sign over a SHA-256 digest.
  const keyType = trustRoot.asymmetricKeyType;
  const algorithm = keyType === "ed25519" || keyType === "ed448" ? null : "sha256";
  let ok = false;
  try {
    ok = cryptoVerify(algorithm, manifestBytes, trustRoot, sig);
  } catch (err) {
    throw new PluginVerificationError(`signature verification errored: ${String(err)}`);
  }
  if (!ok) {
    throw new PluginVerificationError("manifest signature does not match trust root");
  }
}

// Accept either raw DER bytes or a base64/armored .sig file.
function decodeSignature(raw: Buffer): Buffer {
  const text = raw.toString("utf8").trim();
  if (/^[A-Za-z0-9+/\s=]+$/.test(text) && text.length > 0) {
    const compact = text.replace(/\s+/g, "");
    const b = Buffer.from(compact, "base64");
    // Round-trip check: if it re-encodes cleanly it was really base64.
    if (b.length > 0 && b.toString("base64").replace(/=+$/, "") === compact.replace(/=+$/, "")) {
      return b;
    }
  }
  return raw;
}
