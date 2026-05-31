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
  // Uniform-sample one unreserved char per output position via
  // rejection sampling: 256 mod 66 = 58, so bytes in [0, 198) map
  // uniformly; bytes ≥ 198 are rejected and re-drawn. Plain modulo
  // would over-represent the first 58 of 66 chars (CodeQL flags it
  // as a high-severity finding). 64 output chars yields ~380 bits
  // of entropy, well above the spec's 256-bit floor.
  const N = UNRESERVED.length; // 66
  const UNIFORM_CEIL = 256 - (256 % N); // 198
  const out: string[] = [];
  while (out.length < 64) {
    const buf = randomBytes(64);
    for (let i = 0; i < buf.length && out.length < 64; i++) {
      const b = buf[i];
      if (b < UNIFORM_CEIL) out.push(UNRESERVED[b % N]);
    }
  }
  return out.join("");
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
