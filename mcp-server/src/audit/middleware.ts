/**
 * Express middleware that records one audit entry per mutating
 * /api/* request after the response has been sent. Skips read-only
 * methods. In anonymous mode the actor is reported as
 * `anonymous`; in basic mode the session's sub/name are used.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { AuthedRequest } from "../auth/middleware.js";
import { AuditLog } from "./log.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface AuditMiddlewareConfig {
  audit: AuditLog;
  resource: string;
  action: string;
}

/**
 * Build a per-route audit middleware. Pairs cleanly with the RBAC
 * `need(resource, action)` calls already on the route — pass the same
 * (resource, action) pair so the audit entry matches the policy
 * decision that just ran.
 */
export function buildAuditMiddleware(cfg: AuditMiddlewareConfig): RequestHandler {
  return function audit(req: Request, res: Response, next: NextFunction): void {
    if (!MUTATING.has(req.method)) {
      next();
      return;
    }
    res.on("finish", () => {
      const sess = (req as AuthedRequest).session;
      // Pick the most-likely identifier from the route params so the
      // audit entry's `target` lines up with what the operator
      // typed. Most routes use `:name`; products use `:id`; fall
      // through if neither (the entry still records method+path).
      const target = typeof req.params?.name === "string"
        ? req.params.name
        : typeof req.params?.id === "string" ? req.params.id : undefined;
      cfg.audit
        .record({
          actor: sess
            ? { sub: sess.sub, name: sess.name }
            : { sub: "anonymous" },
          tenant: sess?.tenant || "default",
          resource: cfg.resource,
          action: cfg.action,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ip: req.ip || undefined,
          target,
        } as Parameters<typeof cfg.audit.record>[0])
        .catch(() => {
          // record() already swallows file errors — this catch only
          // covers the synchronous Promise wiring.
        });
    });
    next();
  };
}
