/**
 * Minimal RFC 7519 JWT verifier scoped to OIDC ID tokens.
 *
 * Supports the two signature algorithms every real-world OIDC IdP
 * speaks: RS256 and ES256. HS256 is intentionally excluded — for an
 * OIDC code flow the client never shares an HMAC secret with the IdP.
 * "none" is rejected as a matter of basic hygiene.
 *
 * The verifier does *not* fetch JWKS — it expects a JWK keyset
 * already cached by the caller. See `./jwks.ts` for the cache.
 */

import { createPublicKey, createVerify, type KeyObject } from "node:crypto";

export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  // RSA
  n?: string;
  e?: string;
  // EC
  crv?: string;
  x?: string;
  y?: string;
}

export interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

export interface JwtPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nbf?: number;
  nonce?: string;
  [k: string]: unknown;
}

export interface VerifyOpts {
  /** Expected `iss` claim — exact match. */
  issuer: string;
  /** Expected `aud` claim — match if `aud` is a string equal to this,
   *  or an array including this. */
  audience: string;
  /** Expected `nonce` — must match the value tied to the auth-code
   *  flow's state cookie. */
  nonce?: string;
  /** Clock-skew tolerance in seconds; default 30. */
  clockSkewSec?: number;
  /** Override `now` for tests (ms since epoch). */
  now?: () => number;
}

export class JwtVerifyError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "JwtVerifyError";
  }
}

/** Decode base64url to a Buffer (handles missing padding). */
export function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function decodeJson<T>(b64: string): T {
  return JSON.parse(b64urlDecode(b64).toString("utf8")) as T;
}

/** Convert a JWK to a node KeyObject for verification. */
export function jwkToKey(jwk: Jwk): KeyObject {
  // Node accepts JWK directly via `format: "jwk"` since Node 16.
  return createPublicKey({ key: jwk as unknown as Record<string, unknown>, format: "jwk" });
}

/** Verify a compact-serialised JWT against a keyset (JWKS `keys` array)
 * and return its payload. Throws JwtVerifyError on any failure. */
export function verifyIdToken(jwt: string, keys: Jwk[], opts: VerifyOpts): JwtPayload {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new JwtVerifyError("malformed JWT (expected 3 parts)");
  const [headerB64, payloadB64, sigB64] = parts;

  let header: JwtHeader;
  let payload: JwtPayload;
  try {
    header = decodeJson<JwtHeader>(headerB64);
    payload = decodeJson<JwtPayload>(payloadB64);
  } catch {
    throw new JwtVerifyError("malformed JWT (header/payload not JSON)");
  }

  if (header.alg === "none" || !header.alg) throw new JwtVerifyError(`disallowed alg: ${header.alg}`);
  if (header.alg !== "RS256" && header.alg !== "ES256") {
    throw new JwtVerifyError(`unsupported alg: ${header.alg}`);
  }

  // Pick the key — match by kid if present in either header or JWK,
  // otherwise fall back to "the only key of the right kty" which
  // covers single-key JWKS endpoints.
  const wantedKty = header.alg === "RS256" ? "RSA" : "EC";
  let candidates = keys.filter((k) => k.kty === wantedKty);
  if (header.kid) candidates = candidates.filter((k) => !k.kid || k.kid === header.kid);
  if (candidates.length === 0) throw new JwtVerifyError(`no JWK matches kid=${header.kid ?? "?"} kty=${wantedKty}`);

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  const signature = b64urlDecode(sigB64);

  let verified = false;
  let lastErr: unknown;
  for (const jwk of candidates) {
    try {
      const key = jwkToKey(jwk);
      if (header.alg === "RS256") {
        const v = createVerify("RSA-SHA256");
        v.update(signingInput);
        v.end();
        if (v.verify(key, signature)) { verified = true; break; }
      } else {
        // ES256: signature is raw (R||S) 64 bytes. Node accepts that
        // via `dsaEncoding: 'ieee-p1363'`.
        const v = createVerify("SHA256");
        v.update(signingInput);
        v.end();
        if (v.verify({ key, dsaEncoding: "ieee-p1363" }, signature)) { verified = true; break; }
      }
    } catch (e) {
      lastErr = e;
    }
  }
  if (!verified) throw new JwtVerifyError(`signature verification failed${lastErr ? `: ${(lastErr as Error).message}` : ""}`);

  // Claim checks
  const now = Math.floor((opts.now ? opts.now() : Date.now()) / 1000);
  const skew = opts.clockSkewSec ?? 30;
  if (payload.iss !== opts.issuer) throw new JwtVerifyError(`iss mismatch (expected ${opts.issuer}, got ${payload.iss ?? "?"})`);
  const audOk = Array.isArray(payload.aud) ? payload.aud.includes(opts.audience) : payload.aud === opts.audience;
  if (!audOk) throw new JwtVerifyError(`aud mismatch (expected ${opts.audience}, got ${JSON.stringify(payload.aud)})`);
  if (typeof payload.exp !== "number" || now - skew > payload.exp) throw new JwtVerifyError("token expired");
  if (typeof payload.nbf === "number" && now + skew < payload.nbf) throw new JwtVerifyError("token not yet valid");
  if (opts.nonce !== undefined && payload.nonce !== opts.nonce) throw new JwtVerifyError("nonce mismatch");

  return payload;
}
