/**
 * Express middleware wiring for the management-plane auth mode.
 *
 * Split into two pieces by design — the cookie-parsing middleware always
 * runs (so identity-aware handlers like /api/me always see req.session),
 * and the protected-route gate is mounted explicitly on the routes that
 * need it. There is no `if (publicPath) next()` shortcut anywhere — the
 * decision of "what is public" is encoded by which middleware Express
 * registers on which route, not by a string match at request time.
 *
 * When `OMCP_AUTH` is unset or "anonymous" (the default) both middlewares
 * are no-ops and every existing handler behaves exactly as before.
 */

import type { NextFunction, Request, Response } from "express";

import { readCookie, verifySession, type SessionPayload, type SessionConfig } from "./session.js";

export type AuthMode = "anonymous" | "basic";

export interface AuthRuntime {
  mode: AuthMode;
  /** Present only when mode === "basic". */
  session?: SessionConfig;
  /** When true and `secret` not provided, the server generated one for this
   * process — sessions will not survive a restart. The wire-up code logs a
   * warning once when this happens. */
  secretEphemeral?: boolean;
}

export interface AuthedRequest extends Request {
  session?: SessionPayload;
}

/**
 * Best-effort cookie resolver. Attaches `req.session` when present and
 * valid; otherwise leaves it undefined. Always calls `next()`. Mount this
 * globally so every handler can read the identity.
 */
export function buildSessionAttacher(runtime: AuthRuntime) {
  return function sessionAttacher(req: AuthedRequest, _res: Response, next: NextFunction): void {
    if (runtime.mode === "anonymous" || !runtime.session) {
      next();
      return;
    }
    const cookieHeader = req.headers.cookie || "";
    const raw = readCookie(cookieHeader);
    const payload = raw ? verifySession(raw, runtime.session) : null;
    if (payload) req.session = payload;
    next();
  };
}

/**
 * Gate. Rejects requests that lack a valid session with HTTP 401 + a JSON
 * body the UI's fetch wrapper recognises. Mount this on each protected
 * route or router, NOT globally — paths the operator wants public
 * (login, /api/me, /api/info, /healthz, ...) simply don't register it.
 */
export function buildRequireSession(runtime: AuthRuntime) {
  return function requireSession(req: AuthedRequest, res: Response, next: NextFunction): void {
    if (runtime.mode === "anonymous" || !runtime.session) {
      next();
      return;
    }
    if (req.session) {
      next();
      return;
    }
    res.status(401).json({
      error: "authentication required",
      mode: runtime.mode,
      // Recognised by the UI's fetch wrapper to trigger the login modal.
      code: "OMCP_AUTH_REQUIRED",
    });
  };
}
