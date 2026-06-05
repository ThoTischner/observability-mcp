/**
 * Express handlers for the OIDC code flow.
 *
 *   GET  /api/auth/oidc/login     redirect to IdP
 *   GET  /api/auth/oidc/callback  exchange code → mint OMCP session
 *   POST /api/auth/oidc/logout    clear session (+ optional IdP RP-init logout)
 *
 * The handlers are HTTP-framework-aware (they use Express's Request /
 * Response) but otherwise pure; the OIDC client + role resolver come
 * from the runtime built in `./runtime.ts`.
 */

import type { Application, Request, Response } from "express";
import rateLimit from "express-rate-limit";

import type { OidcRuntime } from "./runtime.js";
import { issueSession, setCookieHeader, clearCookieHeader, type SessionConfig } from "../session.js";
import {
  issueFlowCookie,
  verifyFlowCookie,
  setFlowCookieHeader,
  clearFlowCookieHeader,
  readFlowCookie,
  isSafeReturnTo,
} from "./flow-cookie.js";
import {
  dcrEnabled,
  dcrStorePath,
  validateDcrRequest,
  mintRegistration,
  appendRegistration,
  toResponse,
  DcrValidationError,
} from "./dcr.js";

export interface OidcEndpointDeps {
  sessionCfg: SessionConfig;
  oidc: OidcRuntime;
}

function isSecure(req: Request): boolean {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

/** Register the three OIDC endpoints on the given Express app. */
export function registerOidcRoutes(app: Application, deps: OidcEndpointDeps): void {
  const { sessionCfg, oidc } = deps;
  const flowCfg = { secret: sessionCfg.secret };

  app.get("/api/auth/oidc/login", async (req, res) => {
    try {
      const requested = typeof req.query.return_to === "string" ? req.query.return_to : "/";
      const returnTo = isSafeReturnTo(requested) ? requested : "/";
      const start = await oidc.client.start();
      const cookie = issueFlowCookie(
        { state: start.flow.state, nonce: start.flow.nonce, codeVerifier: start.flow.codeVerifier, returnTo },
        flowCfg,
      );
      res.setHeader("Set-Cookie", setFlowCookieHeader(cookie, flowCfg, { secure: isSecure(req) }));
      res.redirect(302, start.authorizeUrl);
    } catch (e) {
      respondError(res, 502, "oidc_start_failed", (e as Error).message);
    }
  });

  app.get("/api/auth/oidc/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const errParam = typeof req.query.error === "string" ? req.query.error : "";
    if (errParam) {
      // The IdP redirected with an error (user cancelled, consent
      // denied, …). Surface plainly; no token exchange needed.
      res.setHeader("Set-Cookie", clearFlowCookieHeader(flowCfg, { secure: isSecure(req) }));
      respondError(res, 400, "oidc_idp_error", errParam);
      return;
    }
    if (!code || !state) {
      // Symmetric with the other early-return paths — once the
      // callback aborts, the flow cookie has no further use; clearing
      // it eagerly avoids reuse on a refresh.
      res.setHeader("Set-Cookie", clearFlowCookieHeader(flowCfg, { secure: isSecure(req) }));
      respondError(res, 400, "oidc_missing_code_or_state", "callback requires both code and state query params");
      return;
    }
    const flowCookieValue = readFlowCookie(req.headers.cookie);
    const flow = verifyFlowCookie(flowCookieValue, flowCfg);
    if (!flow) {
      respondError(res, 400, "oidc_flow_cookie_missing", "no valid flow cookie (expired or absent — please restart login)");
      return;
    }
    let result: Awaited<ReturnType<typeof oidc.client.complete>>;
    try {
      result = await oidc.client.complete({
        code,
        state,
        flow: { state: flow.state, nonce: flow.nonce, codeVerifier: flow.codeVerifier },
      });
    } catch (e) {
      res.setHeader("Set-Cookie", clearFlowCookieHeader(flowCfg, { secure: isSecure(req) }));
      respondError(res, 400, "oidc_token_exchange_failed", (e as Error).message);
      return;
    }
    const claims = result.claims as Record<string, unknown>;
    const sub = sanitiseClaim(claims.sub) ?? "unknown";
    const name = sanitiseClaim(claims.name)
      ?? sanitiseClaim(claims.preferred_username)
      ?? sanitiseClaim(claims.email)
      ?? sub;
    // Only persist email when the IdP marked it verified — an
    // unverified email is operator-supplied user input from the
    // IdP's perspective and shouldn't appear next to a name in
    // an admin UI as if it were authoritative. When the claim is
    // absent we trust it (most IdPs default to verified for the
    // primary identity).
    const emailVerified = claims.email_verified === undefined || claims.email_verified === true;
    const email = emailVerified ? sanitiseClaim(claims.email) : undefined;
    const roles = oidc.resolveRoles(claims);
    const tenant = oidc.resolveTenant(claims);
    const { cookie } = issueSession({ sub, name, email, roles, tenant }, sessionCfg);
    // Two cookies: clear the now-spent flow cookie, set the long-lived
    // session cookie. The browser accepts both in a single response.
    res.setHeader("Set-Cookie", [
      clearFlowCookieHeader(flowCfg, { secure: isSecure(req) }),
      setCookieHeader(cookie, sessionCfg, { secure: isSecure(req) }),
    ]);
    res.redirect(302, flow.returnTo);
  });

  app.post("/api/auth/oidc/logout", (req, res) => {
    res.setHeader("Set-Cookie", clearCookieHeader(sessionCfg, { secure: isSecure(req) }));
    // RP-initiated logout via the discovery doc's end_session_endpoint
    // is intentionally out of scope for slice 3 (we'd need to ferry
    // the id_token through the session payload). Operators wanting an
    // IdP-side logout can configure `OMCP_OIDC_LOGOUT_REDIRECT` to
    // point at their IdP's end-session URL — we 200 here and the UI
    // navigates the user.
    res.status(204).end();
  });

  // RFC 7591 Dynamic Client Registration. Off by default; flip
  // OMCP_OIDC_DCR_ENABLED=true to accept self-registration POSTs
  // (Claude.ai / Cursor / future MCP clients use this to introduce
  // themselves to the gateway). Registrations land at
  // OMCP_OIDC_DCR_STORE (default /tmp/oidc-dcr.json, mode 0600).
  if (dcrEnabled()) {
    const storePath = dcrStorePath();
    // Per-source-IP throttle: 10 registrations per IP per hour. The
    // endpoint is unauthenticated by design (RFC 7591) so without a
    // limiter a single misbehaving client can fill the JSON store.
    // Operators that need a different rate front the gateway with
    // their ingress limiter and lift this floor accordingly.
    const dcrLimiter = rateLimit({
      windowMs: 60 * 60 * 1000,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "rate_limit_exceeded", error_description: "DCR rate limit hit; try later" },
    });
    app.post("/api/auth/oidc/register", dcrLimiter, async (req, res) => {
      try {
        const validated = validateDcrRequest(
          (req.body ?? {}) as Record<string, unknown>,
        );
        const sourceIp =
          (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
          req.ip ||
          "unknown";
        const reg = mintRegistration(validated, sourceIp);
        await appendRegistration(storePath, reg);
        res.status(201).json(toResponse(reg));
      } catch (e) {
        if (e instanceof DcrValidationError) {
          // RFC 7591 §3.2.2 error response shape.
          res.status(400).json({
            error: e.error,
            error_description: e.message,
          });
          return;
        }
        respondError(res, 500, "registration_failed", (e as Error).message);
      }
    });
  }
}

function respondError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: code, message });
}

/** Normalise an IdP-provided claim before we stuff it in the session
 *  cookie: must be a non-empty string, length-capped (so a hostile
 *  IdP can't blow up the cookie), control-character-stripped (so
 *  downstream UIs that render it via innerHTML aren't a vector).
 *  Returns undefined when the claim isn't usable. */
function sanitiseClaim(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  // Strip control characters; keep printable.
  const cleaned = v.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, 200);
}
