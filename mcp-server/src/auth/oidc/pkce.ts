/**
 * PKCE (RFC 7636) helpers for the OIDC authorization-code flow.
 *
 * The `S256` method only — `plain` is disallowed by spec for native /
 * SPA clients and we have no reason to weaken it. Verifier length
 * follows the RFC's recommended 43–128 unreserved-char range.
 */

import { createHash, randomBytes } from "node:crypto";

const UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/** Base64url-encode a Buffer (RFC 4648 §5, no padding). */
export function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a fresh PKCE code_verifier — 64 unreserved chars. */
export function generateCodeVerifier(): string {
  // Each byte → one unreserved char via modulo. Length 64 yields ~380
  // bits of entropy which is well above the 256-bit floor the spec
  // recommends for opaque random strings.
  const bytes = randomBytes(64);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += UNRESERVED[bytes[i] % UNRESERVED.length];
  return out;
}

/** Derive the S256 code_challenge from a verifier. */
export function challengeFromVerifier(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** Convenience: fresh {verifier, challenge} pair. */
export function generatePkcePair(): { verifier: string; challenge: string; method: "S256" } {
  const verifier = generateCodeVerifier();
  return { verifier, challenge: challengeFromVerifier(verifier), method: "S256" };
}
