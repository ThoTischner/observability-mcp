// Dynamic Client Registration (RFC 7591) — minimal implementation.
//
// MCP clients like Claude.ai and Cursor expect to self-register at an
// OAuth authorization server; this endpoint accepts that shape and
// stores the registered metadata on disk so the gateway recognises
// the client on subsequent flows.
//
// Off by default (OMCP_OIDC_DCR_ENABLED=true to enable). Persisted
// to JSON at OMCP_OIDC_DCR_STORE (default /tmp/oidc-dcr.json). Each
// registration is rate-limited per source IP at the route layer to
// keep an unauthenticated POST endpoint from being abused.

import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface DcrRegistrationRequest {
  client_name?: string;
  redirect_uris?: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  scope?: string;
  [k: string]: unknown;
}

export interface DcrRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at: number;
  client_secret_expires_at: number;
  registration_access_token: string;
  // Echo the validated metadata so the client knows what we accepted.
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope?: string;
}

export interface DcrStoreEntry extends DcrRegistrationResponse {
  // Internal: source IP (for audit / abuse triage), creation timestamp.
  _meta: {
    sourceIp: string;
    createdAtIso: string;
  };
}

export class DcrValidationError extends Error {
  constructor(public readonly error: string, message: string) {
    super(message);
    this.name = "DcrValidationError";
  }
}

/** Stable in-process clock for tests. */
export interface DcrDeps {
  now?: () => Date;
  randomToken?: () => string;
  storePath?: string;
}

const DEFAULT_STORE_PATH = "/tmp/oidc-dcr.json";

export function dcrStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.OMCP_OIDC_DCR_STORE || DEFAULT_STORE_PATH;
}

export function dcrEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.OMCP_OIDC_DCR_ENABLED ?? "");
}

/**
 * Validate + normalise a DCR request body. RFC 7591 is permissive,
 * so this is the minimum set the gateway insists on:
 *   - redirect_uris MUST be a non-empty array of absolute https:// URLs
 *     (http:// allowed only when host is localhost / 127.0.0.1)
 *   - grant_types / response_types default to {authorization_code} / {code}
 *   - token_endpoint_auth_method defaults to client_secret_basic
 *
 * Throws DcrValidationError on rejection; the route layer maps it to
 * an RFC 7591 error JSON.
 */
export function validateDcrRequest(body: DcrRegistrationRequest): {
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  client_name?: string;
  scope?: string;
} {
  if (!body || typeof body !== "object") {
    throw new DcrValidationError("invalid_client_metadata", "body must be a JSON object");
  }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (uris.length === 0) {
    throw new DcrValidationError(
      "invalid_redirect_uri",
      "redirect_uris is required and must be a non-empty array",
    );
  }
  for (const u of uris) {
    if (typeof u !== "string") {
      throw new DcrValidationError(
        "invalid_redirect_uri",
        "redirect_uris entries must be strings",
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      throw new DcrValidationError(
        "invalid_redirect_uri",
        `redirect_uri "${u}" is not a valid URL`,
      );
    }
    if (parsed.protocol === "http:") {
      const isLoopback =
        parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "::1";
      if (!isLoopback) {
        throw new DcrValidationError(
          "invalid_redirect_uri",
          `redirect_uri "${u}" must use https:// (http:// only allowed for localhost loopback)`,
        );
      }
    } else if (parsed.protocol !== "https:") {
      throw new DcrValidationError(
        "invalid_redirect_uri",
        `redirect_uri "${u}" must use http:// (loopback) or https://`,
      );
    }
  }
  const grants = Array.isArray(body.grant_types) && body.grant_types.length > 0
    ? body.grant_types
    : ["authorization_code"];
  for (const g of grants) {
    if (typeof g !== "string") {
      throw new DcrValidationError("invalid_client_metadata", "grant_types entries must be strings");
    }
  }
  const responses = Array.isArray(body.response_types) && body.response_types.length > 0
    ? body.response_types
    : ["code"];
  for (const r of responses) {
    if (typeof r !== "string") {
      throw new DcrValidationError("invalid_client_metadata", "response_types entries must be strings");
    }
  }
  const authMethod =
    typeof body.token_endpoint_auth_method === "string" && body.token_endpoint_auth_method.length > 0
      ? body.token_endpoint_auth_method
      : "client_secret_basic";
  return {
    redirect_uris: uris,
    grant_types: grants,
    response_types: responses,
    token_endpoint_auth_method: authMethod,
    client_name: typeof body.client_name === "string" ? body.client_name : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
  };
}

/** Mint a fresh registration. Pure compute except for the random/now
 *  hooks; the route layer is responsible for persisting + emitting
 *  the audit entry. */
export function mintRegistration(
  validated: ReturnType<typeof validateDcrRequest>,
  sourceIp: string,
  deps: DcrDeps = {},
): DcrStoreEntry {
  const now = (deps.now ?? (() => new Date()))();
  const randomToken =
    deps.randomToken ?? (() => randomBytes(32).toString("base64url"));
  const clientId = randomUUID();
  // Public clients (e.g. SPAs with PKCE) typically request
  // token_endpoint_auth_method=none — in that case we don't issue a
  // secret, matching RFC 7591 §3.2.1.
  const clientSecret =
    validated.token_endpoint_auth_method === "none"
      ? undefined
      : randomToken();
  return {
    client_id: clientId,
    client_secret: clientSecret,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    client_secret_expires_at: 0, // 0 = never expires per RFC 7591
    registration_access_token: randomToken(),
    client_name: validated.client_name,
    redirect_uris: validated.redirect_uris,
    grant_types: validated.grant_types,
    response_types: validated.response_types,
    token_endpoint_auth_method: validated.token_endpoint_auth_method,
    scope: validated.scope,
    _meta: {
      sourceIp,
      createdAtIso: now.toISOString(),
    },
  };
}

/** File-backed JSON store of DCR registrations. Single-file, single-
 *  process — multi-replica setups need the F8 shared session store. */
export async function loadRegistrations(
  storePath: string,
): Promise<DcrStoreEntry[]> {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DcrStoreEntry[]) : [];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function appendRegistration(
  storePath: string,
  entry: DcrStoreEntry,
): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true }).catch(() => undefined);
  const existing = await loadRegistrations(storePath);
  existing.push(entry);
  // Write to a tmp file and rename for atomicity.
  const tmp = `${storePath}.tmp`;
  await writeFile(tmp, JSON.stringify(existing, null, 2), { mode: 0o600 });
  await (await import("node:fs/promises")).rename(tmp, storePath);
}

/** Surface-only representation: strips `_meta` before sending the
 *  response. */
export function toResponse(entry: DcrStoreEntry): DcrRegistrationResponse {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _meta, ...rest } = entry;
  return rest;
}
