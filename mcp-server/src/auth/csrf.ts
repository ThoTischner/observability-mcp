// CSRF protection for the SPA — double-submit cookie pattern.
//
// The threat model the gateway protects against:
//   - A browser session that has already authenticated against the
//     SPA (carrying a session cookie) cannot have its credential
//     borrowed by a third-party site to mutate state via a hidden
//     form/XHR. The third-party site cannot read the CSRF cookie,
//     so it cannot echo the token back in the X-CSRF-Token header,
//     so the gateway rejects the request.
//
// The protection is intentionally narrow:
//   - Bearer-token API clients (CI, agents, MCP clients) cannot
//     set cookies and would never carry one. They bypass CSRF via
//     OMCP_CSRF_BYPASS_BEARER=true (default ON since bearer auth
//     is itself proof of intent — there's no browser confused-deputy
//     scenario with a static API token in an Authorization header).
//   - The /mcp endpoint is bearer-only in practice; the SPA only
//     mutates state via /api/*.
//
// Token shape:
//   - 32 random bytes, base64url encoded.
//   - Issued lazily: every authenticated SPA page render that lacks
//     a valid omcp-csrf cookie gets a fresh one.
//   - Server-side validation: header X-CSRF-Token MUST equal cookie
//     omcp-csrf on any state-changing /api/* request.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

export const CSRF_COOKIE = "omcp-csrf";
export const CSRF_HEADER = "x-csrf-token";
export const CSRF_TOKEN_BYTES = 32;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function newCsrfToken(): string {
  return randomBytes(CSRF_TOKEN_BYTES).toString("base64url");
}

export interface CsrfConfig {
  /** Skip protection when an Authorization: Bearer header is present.
   *  Default true — bearer-token clients are non-browser by
   *  definition and cannot carry cookies, so they can't be a
   *  confused-deputy target. Set false to require CSRF on every
   *  state-changing call regardless of auth method. */
  bypassBearer: boolean;
  /** Set cookies with `Secure` flag. Default mirrors the existing
   *  session-cookie behaviour: only when the request is on https. */
  secureCookie: (req: Request) => boolean;
  /** Optional predicate to exempt specific requests from CSRF entirely.
   *  Used for unauthenticated browser-initiated POSTs that can't carry a
   *  token by construction — e.g. CSP violation reports, which the browser
   *  sends with no credentials and no custom headers. Keep this list
   *  minimal: an exempt endpoint must be safe to accept cross-site. */
  skip?: (req: Request) => boolean;
}

export function csrfBypassFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  // Default ON; only the literal opt-out values disable it.
  return !/^(0|false|no|off)$/i.test(env.OMCP_CSRF_BYPASS_BEARER ?? "true");
}

/** Issue a fresh token cookie if the request doesn't already carry a
 *  valid one. The handler runs as a top-of-pipe middleware so every
 *  rendered page picks up a token the SPA can echo back. */
export function buildCsrfIssuer(cfg: CsrfConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const existing = readCookie(req, CSRF_COOKIE);
    if (!existing) {
      const token = newCsrfToken();
      const flags = [
        `${CSRF_COOKIE}=${token}`,
        "Path=/",
        "SameSite=Lax",
        // Intentionally NOT HttpOnly — the SPA's fetch wrapper
        // needs to read this cookie to echo it back in
        // X-CSRF-Token. That's the whole point of double-submit:
        // the value isn't a secret, the proof is "you can read
        // this cookie from your own origin".
      ];
      if (cfg.secureCookie(req)) flags.push("Secure");
      appendSetCookie(res, flags.join("; "));
    }
    next();
  };
}

/** Reject state-changing requests that don't carry a matching
 *  X-CSRF-Token. Safe methods (GET/HEAD/OPTIONS) and bearer-auth
 *  requests (when bypassBearer is on) flow through. */
export function buildCsrfEnforcer(cfg: CsrfConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }
    if (cfg.skip?.(req)) {
      next();
      return;
    }
    if (cfg.bypassBearer) {
      const auth = req.headers["authorization"];
      if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) {
        next();
        return;
      }
      // Also bypass if X-API-Key is set (matches /mcp's accepted shapes).
      if (req.headers["x-api-key"]) {
        next();
        return;
      }
    }
    const headerToken = req.headers[CSRF_HEADER];
    const cookieToken = readCookie(req, CSRF_COOKIE);
    if (
      typeof headerToken !== "string" ||
      typeof cookieToken !== "string" ||
      !constantTimeStringEquals(headerToken, cookieToken)
    ) {
      res
        .status(403)
        .json({
          error: "csrf_token_mismatch",
          message:
            "X-CSRF-Token header is missing or does not match the omcp-csrf cookie",
        });
      return;
    }
    next();
  };
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers["cookie"];
  if (typeof raw !== "string") return undefined;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

function appendSetCookie(res: Response, value: string): void {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", value);
    return;
  }
  res.setHeader("Set-Cookie", Array.isArray(existing) ? [...existing, value] : [String(existing), value]);
}

export function constantTimeStringEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return timingSafeEqual(aBuf, bBuf);
}
