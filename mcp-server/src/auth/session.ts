/**
 * Stateless signed-cookie sessions for the management plane (`/api/*`).
 *
 * The cookie value is `<base64url(payload)>.<base64url(hmacSha256(payload))>`.
 * The payload is a small JSON object with the user's identity, the issued-at
 * timestamp and the absolute expiry. No server-side store; rotating the
 * secret invalidates every outstanding session.
 *
 * MCP transport authentication still uses {@link Credential} bearer tokens
 * — see `./credentials.ts`. This module is exclusively for the browser /
 * UI / `/api/*` plane.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface SessionPayload {
  /** Stable user identifier (username for the local-users store, sub claim for OIDC, ...) */
  sub: string;
  /** Display name shown in the UI. May equal `sub`. */
  name: string;
  /** Optional list of role identifiers — used by later phases for RBAC. */
  roles?: string[];
  /** Issued-at, seconds since epoch. */
  iat: number;
  /** Hard expiry, seconds since epoch. */
  exp: number;
}

export interface SessionConfig {
  /** Symmetric key. Must be at least 32 bytes. */
  secret: string;
  /** Cookie lifetime, seconds. Defaults to 12 hours. */
  ttlSeconds?: number;
  /** Cookie name. Defaults to `omcp_session`. */
  cookieName?: string;
}

export const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;
export const DEFAULT_COOKIE_NAME = "omcp_session";

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

function b64urlDecode(s: string): Buffer | null {
  try {
    return Buffer.from(s, "base64url");
  } catch {
    return null;
  }
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Create a signed cookie value for the given identity. */
export function issueSession(
  identity: Pick<SessionPayload, "sub" | "name" | "roles">,
  cfg: SessionConfig,
  now: number = Math.floor(Date.now() / 1000),
): { cookie: string; payload: SessionPayload } {
  assertSecret(cfg.secret);
  const ttl = cfg.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const payload: SessionPayload = {
    sub: identity.sub,
    name: identity.name,
    roles: identity.roles,
    iat: now,
    exp: now + ttl,
  };
  const payloadStr = b64urlEncode(Buffer.from(JSON.stringify(payload)));
  const sig = sign(cfg.secret, payloadStr);
  return { cookie: `${payloadStr}.${sig}`, payload };
}

/** Reject cookies above this size before any crypto work — practical
 * browser cookies stay well under 4 KB and a runaway input shouldn't
 * even reach the HMAC step. Defense-in-depth; Express's
 * `maxHttpHeaderSize` (16 KB by default) is the outer bound. */
export const MAX_COOKIE_BYTES = 4096;

/** Verify a cookie value. Returns the payload on success, null on any failure. */
export function verifySession(
  cookieValue: string | undefined | null,
  cfg: SessionConfig,
  now: number = Math.floor(Date.now() / 1000),
): SessionPayload | null {
  if (!cookieValue) return null;
  if (cookieValue.length > MAX_COOKIE_BYTES) return null;
  assertSecret(cfg.secret);
  const dot = cookieValue.indexOf(".");
  if (dot <= 0 || dot === cookieValue.length - 1) return null;
  const payloadStr = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  const expected = sign(cfg.secret, payloadStr);
  // Constant-time compare on equal-length buffers; reject length mismatch first.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const raw = b64urlDecode(payloadStr);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (!isSessionPayload(parsed)) return null;
  if (parsed.exp <= now) return null;
  return parsed;
}

function isSessionPayload(v: unknown): v is SessionPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.sub !== "string" || typeof o.name !== "string") return false;
  if (typeof o.iat !== "number" || typeof o.exp !== "number") return false;
  if (o.roles !== undefined && !(Array.isArray(o.roles) && o.roles.every((r) => typeof r === "string"))) return false;
  return true;
}

function assertSecret(secret: string): void {
  if (!secret || secret.length < 32) {
    throw new Error("session secret must be at least 32 characters");
  }
}

/** Render a Set-Cookie header value for an issued session. */
export function setCookieHeader(
  cookie: string,
  cfg: SessionConfig,
  opts: { secure?: boolean } = {},
): string {
  const ttl = cfg.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const name = cfg.cookieName ?? DEFAULT_COOKIE_NAME;
  const parts = [
    `${name}=${cookie}`,
    `Max-Age=${ttl}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.secure !== false) parts.push("Secure");
  return parts.join("; ");
}

/** Render a Set-Cookie header that immediately expires the session cookie. */
export function clearCookieHeader(cfg: SessionConfig, opts: { secure?: boolean } = {}): string {
  const name = cfg.cookieName ?? DEFAULT_COOKIE_NAME;
  const parts = [`${name}=`, "Max-Age=0", "Path=/", "HttpOnly", "SameSite=Lax"];
  if (opts.secure !== false) parts.push("Secure");
  return parts.join("; ");
}

/** Parse the named cookie from a raw Cookie header. */
export function readCookie(cookieHeader: string | undefined | null, name: string = DEFAULT_COOKIE_NAME): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

/** Generate a cryptographically strong fallback secret. Logged-once recommended. */
export function generateSecret(): string {
  return randomBytes(48).toString("base64url");
}
