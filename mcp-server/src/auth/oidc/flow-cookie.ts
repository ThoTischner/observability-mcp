/**
 * Short-lived signed cookie that carries the OIDC code-flow state
 * (state, nonce, code_verifier, returnTo) between the /login redirect
 * and the /callback handler.
 *
 * Signed with HMAC-SHA256 using the same session secret the OMCP
 * session cookie uses — keeps the trust boundary single and obviates
 * a separate key. The payload is a JSON object; the cookie is
 * `<base64url-payload>.<base64url-sig>` like the main session cookie.
 *
 * TTL is intentionally short (5 minutes by default). The auth-code
 * flow is interactive: an IdP that takes longer than that to redirect
 * back is broken, not slow. Short TTL also bounds the window during
 * which a leaked state cookie is exploitable.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface FlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Where to 302 after a successful callback. Always a same-origin
   *  path that begins with `/`; verified at consume time. */
  returnTo: string;
  /** Issued-at, seconds since epoch. */
  iat: number;
  /** Expiry, seconds since epoch. */
  exp: number;
}

export const DEFAULT_FLOW_COOKIE_NAME = "omcp_oidc_flow";
export const DEFAULT_FLOW_TTL_SECONDS = 300; // 5 min
const MAX_COOKIE_BYTES = 4096;

export interface FlowCookieConfig {
  secret: string;
  ttlSeconds?: number;
  cookieName?: string;
}

function b64u(buf: Buffer): string {
  return buf.toString("base64url");
}

function unb64u(s: string): Buffer | null {
  try { return Buffer.from(s, "base64url"); } catch { return null; }
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Build the cookie value carrying the flow state. */
export function issueFlowCookie(
  flow: { state: string; nonce: string; codeVerifier: string; returnTo: string },
  cfg: FlowCookieConfig,
  now: number = Math.floor(Date.now() / 1000),
): string {
  if (!cfg.secret || cfg.secret.length < 32) throw new Error("flow-cookie secret must be ≥ 32 chars");
  const ttl = cfg.ttlSeconds ?? DEFAULT_FLOW_TTL_SECONDS;
  const payload: FlowState = { ...flow, iat: now, exp: now + ttl };
  const payloadStr = b64u(Buffer.from(JSON.stringify(payload)));
  const sig = sign(cfg.secret, payloadStr);
  return `${payloadStr}.${sig}`;
}

/** Decode + verify a cookie value. Returns the flow state on success,
 *  null on any failure (signature mismatch, expired, malformed). */
export function verifyFlowCookie(
  cookieValue: string | undefined | null,
  cfg: FlowCookieConfig,
  now: number = Math.floor(Date.now() / 1000),
): FlowState | null {
  if (!cookieValue) return null;
  if (cookieValue.length > MAX_COOKIE_BYTES) return null;
  if (!cfg.secret || cfg.secret.length < 32) return null;
  const dot = cookieValue.indexOf(".");
  if (dot <= 0 || dot === cookieValue.length - 1) return null;
  const payloadStr = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  const expected = sign(cfg.secret, payloadStr);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const raw = unb64u(payloadStr);
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString("utf8")); } catch { return null; }
  if (!isFlowState(parsed)) return null;
  if (parsed.exp <= now) return null;
  return parsed;
}

function isFlowState(v: unknown): v is FlowState {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.state === "string"
    && typeof o.nonce === "string"
    && typeof o.codeVerifier === "string"
    && typeof o.returnTo === "string"
    && typeof o.iat === "number"
    && typeof o.exp === "number";
}

export function setFlowCookieHeader(
  value: string,
  cfg: FlowCookieConfig,
  opts: { secure?: boolean } = {},
): string {
  const ttl = cfg.ttlSeconds ?? DEFAULT_FLOW_TTL_SECONDS;
  const name = cfg.cookieName ?? DEFAULT_FLOW_COOKIE_NAME;
  const parts = [`${name}=${value}`, `Max-Age=${ttl}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (opts.secure !== false) parts.push("Secure");
  return parts.join("; ");
}

export function clearFlowCookieHeader(cfg: FlowCookieConfig, opts: { secure?: boolean } = {}): string {
  const name = cfg.cookieName ?? DEFAULT_FLOW_COOKIE_NAME;
  const parts = [`${name}=`, "Max-Age=0", "Path=/", "HttpOnly", "SameSite=Lax"];
  if (opts.secure !== false) parts.push("Secure");
  return parts.join("; ");
}

/** Validate a returnTo before using it for the post-callback redirect.
 *  Defends against an attacker stuffing a hostile absolute URL into
 *  the login link (open-redirect). */
export function isSafeReturnTo(path: unknown): path is string {
  if (typeof path !== "string") return false;
  if (path.length === 0 || path.length > 2048) return false;
  // Reject any absolute / scheme-relative shape — only same-origin
  // paths beginning with `/` and NOT `//` are accepted.
  if (!path.startsWith("/")) return false;
  if (path.startsWith("//")) return false;
  if (path.startsWith("/\\")) return false;
  // Reject control characters — a CRLF would be folded into the
  // eventual Location header (header-injection / response-splitting
  // defence in depth; Express also sanitises, but two layers cost
  // nothing).
  if (/[\x00-\x1f\x7f]/.test(path)) return false;
  return true;
}

/** Parse a Cookie header for the flow cookie's value. Tolerates other
 *  cookies (session, CSRF, etc.) sharing the header. */
export function readFlowCookie(cookieHeader: string | undefined | null, name: string = DEFAULT_FLOW_COOKIE_NAME): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
