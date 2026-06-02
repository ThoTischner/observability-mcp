/**
 * External OPA (Open Policy Agent) policy engine.
 *
 * Calls an OPA server over its Data API (POST /v1/data/<path>) to
 * evaluate every RBAC decision against a Rego policy the operator
 * authors and loads into OPA. This lets enterprise users keep their
 * single source of policy truth (a Rego bundle deployed alongside
 * everything else) instead of duplicating the rules in YAML here.
 *
 * Wire format (input):
 *   POST /v1/data/{package}
 *   { "input": { "roles": ["admin"], "resource": "sources", "action": "delete" } }
 *
 * Expected response shape:
 *   { "result": true | false }
 *      OR
 *   { "result": { "allowed": true|false, "reason"?: string, "permissions"?: [{resource, action}, ...] } }
 *
 * The second form lets an operator return both a verdict and the
 * full per-role permission list from the same package, which the
 * UI uses to render the policy snapshot. Plain boolean form is
 * also accepted for minimal policies; in that case .list() returns
 * an empty array with a "not supported by this OPA package" reason
 * surfaced via kind().
 *
 * No new dependency: uses `fetch` (already in the egress allowlist
 * for auth/oidc/, and OPA traffic stays inside the cluster).
 */

import type { Permission, Resource, Action } from "../rbac.js";
import type { PolicyEngine, EvalResult, EvalContext } from "./engine.js";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface OpaConfig {
  /** Base URL, e.g. http://opa:8181 (no trailing slash). */
  url: string;
  /** Data path, e.g. "observability/authz". POSTed to /v1/data/<path>. */
  packagePath: string;
  /** Optional list of role names the operator wants the UI to show.
   *  OPA doesn't expose roles natively, so this is config-side. */
  declaredRoles?: string[];
  /** Optional bearer token for OPA's `--authentication=token`. */
  bearerToken?: string;
  /** Request timeout in ms. Default 1500. OPA decisions should be
   *  millisecond-fast; a slow OPA almost always means the network
   *  is wrong, not the policy. */
  timeoutMs?: number;
  /** Custom fetcher (tests). */
  fetcher?: Fetcher;
}

interface RichResult {
  allowed?: boolean;
  reason?: string;
  permissions?: Array<{ resource: string; action: string }>;
}

export class OpaPolicyEngine implements PolicyEngine {
  private readonly cfg: OpaConfig;
  private readonly fetcher: Fetcher;
  // Tiny per-(role, resource, action) cache so a render of /api/me
  // doesn't fire 30 OPA calls per second. 5s TTL is short enough
  // that a policy update at OPA is reflected promptly; long enough
  // that bursts of UI loads coalesce.
  private cache = new Map<string, { at: number; result: EvalResult }>();
  private readonly cacheTtlMs = 5_000;
  // List cache is per-role and slightly longer-lived since list() is
  // only used for /api/me / Policy UI which the user doesn't refresh
  // every 200ms.
  private listCache = new Map<string, { at: number; perms: Permission[] }>();
  private readonly listCacheTtlMs = 30_000;

  constructor(cfg: OpaConfig) {
    this.cfg = { timeoutMs: 1500, ...cfg };
    this.fetcher = cfg.fetcher ?? ((u, i) => fetch(u, i));
  }

  private cacheKey(roles: string[], resource: string, action: string, tenant?: string): string {
    // NUL-delimited so role names containing "," / "|" can't alias
    // across role sets ({"a,b"} would otherwise collide with {"a","b"}).
    // Tenant is part of the key so cross-tenant decisions don't share
    // cache slots — required once we thread tenant into the OPA input.
    const tk = tenant || "";
    return roles.slice().sort().join("\x00") + "\x01" + resource + "\x01" + action + "\x01" + tk;
  }

  private now(): number {
    return Date.now();
  }

  private async query<T = unknown>(payload: unknown): Promise<{ result?: T }> {
    const url = `${this.cfg.url.replace(/\/$/, "")}/v1/data/${this.cfg.packagePath.replace(/^\//, "")}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 1500);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.cfg.bearerToken) headers.authorization = `Bearer ${this.cfg.bearerToken}`;
      const res = await this.fetcher(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return (await res.json()) as { result?: T };
    } finally {
      clearTimeout(timer);
    }
  }

  evaluate(roles: string[] | undefined, resource: Resource, action: Action, ctx?: EvalContext): EvalResult {
    const rs = roles && roles.length > 0 ? roles : [];
    const tenant = ctx?.tenant;
    // The PolicyEngine.evaluate contract is sync to keep the hot
    // gate path off the await stack, so we serve from the cache
    // synchronously and warm the cache lazily on miss. Misses fall
    // back to a conservative deny + the cache will be populated for
    // next time.
    const key = this.cacheKey(rs, resource, action, tenant);
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < this.cacheTtlMs) return cached.result;
    // Fire and forget: populate the cache; this call is racy on
    // first miss (deny while warming) but the next call within the
    // TTL returns the real verdict. For sync-required contracts we
    // accept that trade-off vs. blocking every request handler.
    void this.warmEvaluate(rs, resource, action, tenant);
    return { allowed: false, reason: "OPA decision pending (warming cache); request again" };
  }

  /** Async warm of the evaluate cache. Public so a long-running
   *  caller can `await engine.warmEvaluate(...)` before the gate
   *  check if it cannot tolerate the warming-deny window. */
  async warmEvaluate(roles: string[], resource: string, action: string, tenant?: string): Promise<EvalResult> {
    const key = this.cacheKey(roles, resource, action, tenant);
    try {
      // input.tenant is always included (undefined → null in JSON
      // serialisation, omitted by JSON.stringify default) so Rego
      // authors can write `input.tenant == "acme"` rules without
      // tripping on missing-field. When the caller didn't supply
      // tenant we still include the key with `undefined` value;
      // JSON.stringify drops it cleanly.
      const out = await this.query<boolean | RichResult>({ input: { roles, resource, action, tenant } });
      const raw = out.result;
      let result: EvalResult;
      if (raw === true || raw === false) {
        result = { allowed: raw, reason: raw ? "allowed by OPA" : "denied by OPA" };
      } else if (raw && typeof raw === "object") {
        result = {
          allowed: !!raw.allowed,
          reason: typeof raw.reason === "string" ? raw.reason : (raw.allowed ? "allowed by OPA" : "denied by OPA"),
        };
      } else {
        result = { allowed: false, reason: `OPA returned an unrecognised result shape: ${JSON.stringify(raw)}` };
      }
      this.cache.set(key, { at: this.now(), result });
      return result;
    } catch (e) {
      const result = { allowed: false, reason: `OPA query failed: ${(e as Error).message}` };
      // Cache the failure for a SHORT window so a flapping OPA
      // doesn't get hammered, but not for the full TTL.
      this.cache.set(key, { at: this.now() - this.cacheTtlMs + 1000, result });
      return result;
    }
  }

  list(roles: string[] | undefined, ctx?: EvalContext): Permission[] {
    if (!roles || roles.length === 0) return [];
    const tenant = ctx?.tenant || "";
    const key = roles.slice().sort().join("\x00") + "\x01" + tenant;
    const cached = this.listCache.get(key);
    if (cached && this.now() - cached.at < this.listCacheTtlMs) return cached.perms;
    void this.warmList(roles, ctx?.tenant);
    return [];
  }

  async warmList(roles: string[], tenant?: string): Promise<Permission[]> {
    const key = roles.slice().sort().join("\x00") + "\x01" + (tenant || "");
    try {
      const out = await this.query<boolean | RichResult>({ input: { roles, list: true, tenant } });
      const raw = out.result;
      let perms: Permission[] = [];
      if (raw && typeof raw === "object" && Array.isArray(raw.permissions)) {
        perms = raw.permissions
          .filter((p) => p && typeof p.resource === "string" && typeof p.action === "string")
          .map((p) => ({ resource: p.resource as Resource, action: p.action as Action }));
      }
      this.listCache.set(key, { at: this.now(), perms });
      return perms;
    } catch {
      this.listCache.set(key, { at: this.now(), perms: [] });
      return [];
    }
  }

  roles(): string[] {
    return this.cfg.declaredRoles ?? [];
  }

  kind(): string {
    return `opa:${this.cfg.url}`;
  }
}
