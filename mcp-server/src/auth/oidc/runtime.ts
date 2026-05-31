/**
 * Resolve the OIDC configuration from environment variables and turn
 * it into the runtime shape the rest of the auth layer consumes.
 *
 * Mirrors the basic-mode resolution in src/index.ts: fail-closed on
 * missing required config, allow an `OMCP_AUTH_ALLOW_FALLBACK=true`
 * opt-out (handled by the caller — this module just signals via the
 * `error` field).
 *
 * Required env (when OMCP_AUTH=oidc):
 *   OMCP_OIDC_ISSUER         — IdP base URL (no trailing /.well-known/...)
 *   OMCP_OIDC_CLIENT_ID
 *   OMCP_OIDC_REDIRECT_URI   — absolute, MUST match the registration
 *
 * Optional env:
 *   OMCP_OIDC_CLIENT_SECRET  — confidential clients; public clients omit
 *   OMCP_OIDC_SCOPES         — default "openid profile email"
 *   OMCP_OIDC_ROLES_CLAIM    — dotted path; default "groups"
 *   OMCP_OIDC_ROLE_MAP       — JSON {"<claim-value>": "<omcp-role>"};
 *                              entries map directly to RBAC roles
 *                              (viewer / operator / admin or custom).
 *   OMCP_OIDC_LOGOUT_REDIRECT — post-logout landing URL (default "/")
 */

import { OidcClient, type OidcConfig } from "./client.js";

export interface OidcRuntimeConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string;
  rolesClaim: string;
  roleMap: Record<string, string>;
  logoutRedirect: string;
}

export interface ResolveOidcResult {
  /** Fully validated runtime config; absent when `error` is set. */
  config?: OidcRuntimeConfig;
  /** Human-readable misconfiguration reason; used for the boot log
   *  + fail-closed exit. */
  error?: string;
}

/** Pure env-to-config translator. No I/O. */
export function resolveOidcConfig(env: NodeJS.ProcessEnv = process.env): ResolveOidcResult {
  const issuer = nonEmpty(env.OMCP_OIDC_ISSUER);
  const clientId = nonEmpty(env.OMCP_OIDC_CLIENT_ID);
  const redirectUri = nonEmpty(env.OMCP_OIDC_REDIRECT_URI);
  const missing: string[] = [];
  if (!issuer) missing.push("OMCP_OIDC_ISSUER");
  if (!clientId) missing.push("OMCP_OIDC_CLIENT_ID");
  if (!redirectUri) missing.push("OMCP_OIDC_REDIRECT_URI");
  if (missing.length > 0) {
    return { error: `OMCP_AUTH=oidc requires ${missing.join(", ")}` };
  }

  if (!/^https?:\/\//i.test(issuer!)) {
    return { error: `OMCP_OIDC_ISSUER must be an absolute http(s):// URL, got ${issuer}` };
  }
  if (!/^https?:\/\//i.test(redirectUri!)) {
    return { error: `OMCP_OIDC_REDIRECT_URI must be an absolute http(s):// URL, got ${redirectUri}` };
  }

  let roleMap: Record<string, string> = {};
  const roleMapRaw = nonEmpty(env.OMCP_OIDC_ROLE_MAP);
  if (roleMapRaw) {
    try {
      const parsed = JSON.parse(roleMapRaw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { error: "OMCP_OIDC_ROLE_MAP must be a JSON object of {\"claim-value\":\"omcp-role\"}" };
      }
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v !== "string") {
          return { error: `OMCP_OIDC_ROLE_MAP[${k}] must be a string, got ${typeof v}` };
        }
        roleMap[k] = v;
      }
    } catch (e) {
      return { error: `OMCP_OIDC_ROLE_MAP is not valid JSON: ${(e as Error).message}` };
    }
  }

  return {
    config: {
      issuer: issuer!.replace(/\/$/, ""),
      clientId: clientId!,
      clientSecret: nonEmpty(env.OMCP_OIDC_CLIENT_SECRET),
      redirectUri: redirectUri!,
      scopes: nonEmpty(env.OMCP_OIDC_SCOPES) ?? "openid profile email",
      rolesClaim: nonEmpty(env.OMCP_OIDC_ROLES_CLAIM) ?? "groups",
      roleMap,
      logoutRedirect: nonEmpty(env.OMCP_OIDC_LOGOUT_REDIRECT) ?? "/",
    },
  };
}

/** Build the OidcClient + the role-resolution helper from a resolved
 * runtime config. Tests can stub OidcClient by passing a custom one. */
export interface OidcRuntime {
  cfg: OidcRuntimeConfig;
  client: OidcClient;
  /** Walk a JWT claim set, follow the rolesClaim dotted path, and
   *  return the OMCP role names the user inherits via roleMap.
   *  Unknown claim values are silently dropped (least-privilege). */
  resolveRoles(claims: Record<string, unknown>): string[];
}

export function buildOidcRuntime(cfg: OidcRuntimeConfig, opts: { client?: OidcClient } = {}): OidcRuntime {
  const client = opts.client ?? new OidcClient({
    issuer: cfg.issuer,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    redirectUri: cfg.redirectUri,
    scopes: cfg.scopes,
  } satisfies OidcConfig);
  return {
    cfg,
    client,
    resolveRoles(claims) {
      const raw = lookupClaim(claims, cfg.rolesClaim);
      const values: string[] = Array.isArray(raw)
        ? raw.filter((v): v is string => typeof v === "string")
        : typeof raw === "string"
          ? [raw]
          : [];
      const roles = new Set<string>();
      for (const v of values) {
        const mapped = cfg.roleMap[v];
        if (mapped) roles.add(mapped);
      }
      return [...roles];
    },
  };
}

function nonEmpty(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function lookupClaim(claims: Record<string, unknown>, dottedPath: string): unknown {
  const parts = dottedPath.split(".");
  let cur: unknown = claims;
  for (const p of parts) {
    if (cur && typeof cur === "object" && !Array.isArray(cur) && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}
