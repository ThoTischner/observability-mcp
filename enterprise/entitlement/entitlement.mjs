// Ed25519-signed entitlement token verification (FSL-1.1-Apache-2.0).
//
// An entitlement token authorises which enterprise features an operator
// deployment may switch on. Format (compact, URL-safe, dependency-free):
//
//     base64url(canonicalPayloadJSON) "." base64url(ed25519Signature)
//
// Payload claims:
//   { sub, tier, features: string[], iat, exp }   (iat/exp = epoch seconds)
//
// The issuer (us) signs with an Ed25519 private key; the deployment
// verifies with the embedded/configured public key. Verification is
// DEFAULT-DENY: any structural, signature, or temporal failure yields
// { valid:false } and `requireFeature` throws — a missing or bad token
// never silently unlocks a feature.
//
// Pure crypto via node:crypto only. The clock is injectable so expiry
// logic is deterministically testable.

import { sign as edSign, verify as edVerify } from "node:crypto";

// Deterministic JSON (stable recursive key order) so the exact bytes
// signed by the issuer are the exact bytes verified here.
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

/** Issuer side (also used by tests/tooling): sign a payload. */
export function signEntitlement(payload, privateKey) {
  const bytes = Buffer.from(canonical(payload), "utf8");
  const sig = edSign(null, bytes, privateKey);
  return `${b64url(bytes)}.${b64url(sig)}`;
}

/**
 * Verify an entitlement token.
 * @param token      "<b64url payload>.<b64url sig>"
 * @param publicKey  Ed25519 public key (KeyObject or PEM string)
 * @param opts.now   () => epoch seconds (injectable; default real clock)
 * @param opts.skew  allowed clock skew in seconds for iat (default 60)
 * @returns {{valid:boolean, reason:string, claims?:object}}
 */
export function verifyEntitlement(token, publicKey, opts = {}) {
  const now = typeof opts.now === "function" ? opts.now : () => Math.floor(Date.now() / 1000);
  const skew = Number.isFinite(opts.skew) ? opts.skew : 60;

  if (typeof token !== "string" || token.indexOf(".") < 0) {
    return { valid: false, reason: "malformed token" };
  }
  const [p, s] = token.split(".");
  if (!p || !s) return { valid: false, reason: "malformed token (missing segment)" };

  let payloadBytes;
  let claims;
  try {
    payloadBytes = b64urlDecode(p);
    claims = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return { valid: false, reason: "payload not valid base64url JSON" };
  }
  if (!claims || typeof claims !== "object") {
    return { valid: false, reason: "payload is not an object" };
  }

  let sigOk = false;
  try {
    sigOk = edVerify(null, payloadBytes, publicKey, b64urlDecode(s));
  } catch {
    return { valid: false, reason: "signature could not be verified (bad key?)" };
  }
  if (!sigOk) return { valid: false, reason: "signature mismatch" };

  // Re-canonicalise: reject a token whose JSON encoding isn't canonical,
  // so the signed bytes are unambiguous (defence against payload reshaping).
  if (canonical(claims) !== payloadBytes.toString("utf8")) {
    return { valid: false, reason: "payload not in canonical form" };
  }

  const t = now();
  if (typeof claims.exp === "number" && t >= claims.exp) {
    return { valid: false, reason: "token expired" };
  }
  if (typeof claims.iat === "number" && claims.iat > t + skew) {
    return { valid: false, reason: "token not yet valid (iat in the future)" };
  }

  return { valid: true, reason: "ok", claims };
}

/** True iff the verified claims grant a feature ("*" = all features). */
export function hasFeature(claims, feature) {
  if (!claims || !Array.isArray(claims.features)) return false;
  return claims.features.includes("*") || claims.features.includes(feature);
}

export class EntitlementError extends Error {
  constructor(reason) {
    super(`Entitlement denied: ${reason}`);
    this.name = "EntitlementError";
    this.code = "ENTITLEMENT_DENIED";
    this.reason = reason;
  }
}

/**
 * Gate: verify the token AND require a feature. Throws EntitlementError
 * on any failure (default-deny). Returns the verified claims on success.
 */
export function requireFeature(token, publicKey, feature, opts = {}) {
  const res = verifyEntitlement(token, publicKey, opts);
  if (!res.valid) throw new EntitlementError(res.reason);
  if (!hasFeature(res.claims, feature)) {
    throw new EntitlementError(`feature '${feature}' not entitled`);
  }
  return res.claims;
}
