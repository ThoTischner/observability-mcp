/**
 * High-level OIDC client: glues discovery + JWKS + JWT verify + the
 * auth-code+PKCE token exchange behind a single small surface.
 *
 * Designed to be wired into the existing session middleware in a
 * later slice. This module stays HTTP-framework agnostic — the caller
 * decides how to ferry the state/nonce/code_verifier between the
 * `start()` redirect and the `complete()` callback (we recommend a
 * short-lived signed cookie).
 */

import { DiscoveryClient, type DiscoveryDocument, type Fetcher } from "./discovery.js";
import { JwksClient } from "./jwks.js";
import { generatePkcePair } from "./pkce.js";
import { verifyIdToken, type JwtPayload } from "./jwt.js";
import { randomBytes } from "node:crypto";

export interface OidcConfig {
  /** Issuer URL — what the IdP advertises in its discovery `issuer` field. */
  issuer: string;
  clientId: string;
  /** Confidential clients only. Public/SPA clients omit and rely on PKCE. */
  clientSecret?: string;
  /** Absolute callback URL registered with the IdP. */
  redirectUri: string;
  /** Space-delimited scopes. Default: "openid profile email". */
  scopes?: string;
  /** Custom fetcher (tests). */
  fetcher?: Fetcher;
  /** Test clock. */
  now?: () => number;
}

export interface StartResult {
  /** Where to 302 the browser. */
  authorizeUrl: string;
  /** Caller stores these in a short-lived cookie until /callback. */
  flow: {
    state: string;
    nonce: string;
    codeVerifier: string;
  };
}

export interface CompleteOpts {
  /** Authorization code from the callback URL. */
  code: string;
  /** State returned by the IdP — must match the cookie's flow.state. */
  state: string;
  /** The flow object the caller stashed in the cookie at start(). */
  flow: { state: string; nonce: string; codeVerifier: string };
}

export interface CompleteResult {
  /** Decoded + verified ID-token claims. */
  claims: JwtPayload;
  /** Raw ID token (for upstream propagation if the caller wants it). */
  idToken: string;
  /** Access token (opaque). */
  accessToken?: string;
}

export class OidcClient {
  private readonly discovery: DiscoveryClient;
  private readonly jwks: JwksClient;
  private readonly cfg: OidcConfig;
  private readonly fetcher: Fetcher;
  private readonly now: () => number;

  constructor(cfg: OidcConfig) {
    this.cfg = cfg;
    this.fetcher = cfg.fetcher ?? ((u, i) => fetch(u, i));
    this.now = cfg.now ?? Date.now;
    this.discovery = new DiscoveryClient({ fetcher: this.fetcher, now: this.now });
    this.jwks = new JwksClient({ fetcher: this.fetcher, now: this.now });
  }

  /** Build an authorize URL + mint the state/nonce/PKCE-verifier the
   * caller must persist until the callback. */
  async start(): Promise<StartResult> {
    const doc = await this.discovery.discover(this.cfg.issuer);
    const pkce = generatePkcePair();
    const state = base64url(randomBytes(24));
    const nonce = base64url(randomBytes(24));
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      scope: this.cfg.scopes ?? "openid profile email",
      state,
      nonce,
      code_challenge: pkce.challenge,
      code_challenge_method: pkce.method,
    });
    return {
      authorizeUrl: `${doc.authorization_endpoint}?${params.toString()}`,
      flow: { state, nonce, codeVerifier: pkce.verifier },
    };
  }

  /** Validate the callback: state match → token exchange → ID-token
   *  signature + claim verification. Throws on any failure. */
  async complete(opts: CompleteOpts): Promise<CompleteResult> {
    if (opts.state !== opts.flow.state) throw new Error("OIDC callback: state mismatch");
    const doc = await this.discovery.discover(this.cfg.issuer);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: this.cfg.redirectUri,
      client_id: this.cfg.clientId,
      code_verifier: opts.flow.codeVerifier,
    });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    if (this.cfg.clientSecret) {
      const basic = Buffer.from(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`).toString("base64");
      headers.authorization = `Basic ${basic}`;
    }
    const res = await this.fetcher(doc.token_endpoint, { method: "POST", headers, body: body.toString() });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OIDC token exchange failed: HTTP ${res.status} ${text}`);
    }
    const tokens = (await res.json()) as { id_token?: string; access_token?: string };
    if (!tokens.id_token) throw new Error("OIDC token response missing id_token");
    const claims = await this.verify(tokens.id_token, doc, opts.flow.nonce);
    return { claims, idToken: tokens.id_token, accessToken: tokens.access_token };
  }

  /** Verify a standalone ID token (refresh flows, replay checks). */
  async verify(idToken: string, doc?: DiscoveryDocument, nonce?: string): Promise<JwtPayload> {
    const d = doc ?? (await this.discovery.discover(this.cfg.issuer));
    const header = parseHeader(idToken);
    const key = await this.jwks.findKey(d.jwks_uri, header.kid);
    if (!key) throw new Error(`OIDC: no JWKS key for kid=${header.kid ?? "?"}`);
    return verifyIdToken(idToken, [key], {
      issuer: this.cfg.issuer,
      audience: this.cfg.clientId,
      nonce,
      now: this.now,
    });
  }
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function parseHeader(jwt: string): { alg: string; kid?: string } {
  const [h] = jwt.split(".");
  if (!h) throw new Error("malformed JWT");
  const pad = h.length % 4 === 0 ? "" : "=".repeat(4 - (h.length % 4));
  return JSON.parse(Buffer.from(h.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8"));
}
