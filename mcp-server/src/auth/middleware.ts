/**
 * Express middleware wiring for the management-plane auth mode.
 *
 * When `OMCP_AUTH` is unset or "anonymous" (the default), the middleware
 * is a no-op and every existing handler behaves exactly as before.
 *
 * When `OMCP_AUTH=basic`, the middleware:
 *   1. Resolves the request's session cookie and attaches the payload
 *      to `req.session` (always — both for protected and unprotected
 *      paths so `/api/me` etc. can see the identity).
 *   2. Rejects any request to a protected path that lacks a valid
 *      session with HTTP 401 + a small JSON body the UI can recognise.
 *
 * "Protected path" = anything under `/api/` except the always-public
 * discovery / login endpoints (`/api/me`, `/api/auth/*`). The `/mcp`
 * transport keeps using `auth/credentials.ts` bearer tokens.
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

/** Paths that bypass the gate in basic mode, even when no session is present. */
const ALWAYS_PUBLIC_PREFIXES = ["/api/me", "/api/auth/", "/api/info", "/api/openapi.json"];

export function isAlwaysPublic(path: string): boolean {
  for (const p of ALWAYS_PUBLIC_PREFIXES) {
    // Exact match, or a child path under a directory-style prefix
    // (one ending in "/"). Avoids accidentally matching e.g.
    // `/api/members` when `/api/me` is on the list.
    if (path === p) return true;
    if (p.endsWith("/") && path.startsWith(p)) return true;
  }
  // Health probes are also always public so the readiness gate works
  // before any session is established and Kubernetes can still probe.
  if (path === "/healthz" || path === "/readyz" || path === "/metrics") return true;
  return false;
}

/** Build the Express middleware that enforces the configured auth mode. */
export function buildAuthMiddleware(runtime: AuthRuntime) {
  return function authMiddleware(req: AuthedRequest, res: Response, next: NextFunction): void {
    if (runtime.mode === "anonymous" || !runtime.session) {
      next();
      return;
    }

    // Resolve the session (best-effort) for every request so identity-aware
    // handlers like /api/me can use it without re-parsing.
    const cookieHeader = req.headers.cookie || "";
    const raw = readCookie(cookieHeader);
    const payload = raw ? verifySession(raw, runtime.session) : null;
    if (payload) req.session = payload;

    // Apply the gate only to the management plane. /mcp has its own
    // bearer-token middleware (auth/credentials.ts) and the public paths
    // listed above are skipped here.
    if (!req.path.startsWith("/api/")) {
      next();
      return;
    }
    if (isAlwaysPublic(req.path)) {
      next();
      return;
    }
    if (payload) {
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
