import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveOidcConfig, buildOidcRuntime } from "./runtime.js";

function envOf(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

test("resolveOidcConfig — happy path with required vars only", () => {
  const r = resolveOidcConfig(envOf({
    OMCP_OIDC_ISSUER: "https://idp.test",
    OMCP_OIDC_CLIENT_ID: "c-1",
    OMCP_OIDC_REDIRECT_URI: "https://app.test/cb",
  }));
  assert.equal(r.error, undefined);
  assert.deepEqual(r.config, {
    issuer: "https://idp.test",
    clientId: "c-1",
    clientSecret: undefined,
    redirectUri: "https://app.test/cb",
    scopes: "openid profile email",
    rolesClaim: "groups",
    roleMap: {},
    logoutRedirect: "/",
  });
});

test("resolveOidcConfig — surfaces ALL missing required vars in one message", () => {
  const r = resolveOidcConfig(envOf({}));
  assert.match(r.error ?? "", /OMCP_OIDC_ISSUER.*OMCP_OIDC_CLIENT_ID.*OMCP_OIDC_REDIRECT_URI/);
  assert.equal(r.config, undefined);
});

test("resolveOidcConfig — rejects non-URL issuer / redirect", () => {
  const r1 = resolveOidcConfig(envOf({
    OMCP_OIDC_ISSUER: "idp.test",
    OMCP_OIDC_CLIENT_ID: "c", OMCP_OIDC_REDIRECT_URI: "https://app.test/cb",
  }));
  assert.match(r1.error ?? "", /OMCP_OIDC_ISSUER must be an absolute/);
  const r2 = resolveOidcConfig(envOf({
    OMCP_OIDC_ISSUER: "https://idp.test", OMCP_OIDC_CLIENT_ID: "c",
    OMCP_OIDC_REDIRECT_URI: "/cb",
  }));
  assert.match(r2.error ?? "", /OMCP_OIDC_REDIRECT_URI must be an absolute/);
});

test("resolveOidcConfig — strips a single trailing slash off issuer", () => {
  const r = resolveOidcConfig(envOf({
    OMCP_OIDC_ISSUER: "https://idp.test/",
    OMCP_OIDC_CLIENT_ID: "c", OMCP_OIDC_REDIRECT_URI: "https://app.test/cb",
  }));
  assert.equal(r.config?.issuer, "https://idp.test");
});

test("resolveOidcConfig — empty strings count as missing", () => {
  const r = resolveOidcConfig(envOf({
    OMCP_OIDC_ISSUER: "  ",
    OMCP_OIDC_CLIENT_ID: "",
    OMCP_OIDC_REDIRECT_URI: "https://app.test/cb",
  }));
  assert.match(r.error ?? "", /OMCP_OIDC_ISSUER.*OMCP_OIDC_CLIENT_ID/);
});

test("resolveOidcConfig — parses OMCP_OIDC_ROLE_MAP JSON", () => {
  const r = resolveOidcConfig(envOf({
    OMCP_OIDC_ISSUER: "https://idp.test", OMCP_OIDC_CLIENT_ID: "c",
    OMCP_OIDC_REDIRECT_URI: "https://app.test/cb",
    OMCP_OIDC_ROLE_MAP: '{"omcp-admin":"admin","omcp-ops":"operator","omcp-viewers":"viewer"}',
  }));
  assert.deepEqual(r.config?.roleMap, { "omcp-admin": "admin", "omcp-ops": "operator", "omcp-viewers": "viewer" });
});

test("resolveOidcConfig — rejects malformed OMCP_OIDC_ROLE_MAP", () => {
  const bad = resolveOidcConfig(envOf({
    OMCP_OIDC_ISSUER: "https://idp.test", OMCP_OIDC_CLIENT_ID: "c",
    OMCP_OIDC_REDIRECT_URI: "https://app.test/cb",
    OMCP_OIDC_ROLE_MAP: "not json",
  }));
  assert.match(bad.error ?? "", /not valid JSON/);
  const wrongType = resolveOidcConfig(envOf({
    OMCP_OIDC_ISSUER: "https://idp.test", OMCP_OIDC_CLIENT_ID: "c",
    OMCP_OIDC_REDIRECT_URI: "https://app.test/cb",
    OMCP_OIDC_ROLE_MAP: '["arr"]',
  }));
  assert.match(wrongType.error ?? "", /JSON object/);
  const wrongValue = resolveOidcConfig(envOf({
    OMCP_OIDC_ISSUER: "https://idp.test", OMCP_OIDC_CLIENT_ID: "c",
    OMCP_OIDC_REDIRECT_URI: "https://app.test/cb",
    OMCP_OIDC_ROLE_MAP: '{"x": 1}',
  }));
  assert.match(wrongValue.error ?? "", /must be a string/);
});

test("resolveOidcConfig — propagates OMCP_OIDC_CLIENT_SECRET (confidential client)", () => {
  const r = resolveOidcConfig(envOf({
    OMCP_OIDC_ISSUER: "https://idp.test",
    OMCP_OIDC_CLIENT_ID: "c-1",
    OMCP_OIDC_CLIENT_SECRET: "confidential-shared-secret",
    OMCP_OIDC_REDIRECT_URI: "https://app.test/cb",
  }));
  assert.equal(r.config?.clientSecret, "confidential-shared-secret");
});

test("resolveOidcConfig — honours OMCP_OIDC_SCOPES / ROLES_CLAIM / LOGOUT_REDIRECT", () => {
  const r = resolveOidcConfig(envOf({
    OMCP_OIDC_ISSUER: "https://idp.test", OMCP_OIDC_CLIENT_ID: "c",
    OMCP_OIDC_REDIRECT_URI: "https://app.test/cb",
    OMCP_OIDC_SCOPES: "openid email custom-scope",
    OMCP_OIDC_ROLES_CLAIM: "realm_access.roles",
    OMCP_OIDC_LOGOUT_REDIRECT: "https://app.test/bye",
  }));
  assert.equal(r.config?.scopes, "openid email custom-scope");
  assert.equal(r.config?.rolesClaim, "realm_access.roles");
  assert.equal(r.config?.logoutRedirect, "https://app.test/bye");
});

test("buildOidcRuntime.resolveRoles — flat groups claim with array value", () => {
  const r = resolveOidcConfig(envOf({
    OMCP_OIDC_ISSUER: "https://idp.test", OMCP_OIDC_CLIENT_ID: "c",
    OMCP_OIDC_REDIRECT_URI: "https://app.test/cb",
    OMCP_OIDC_ROLE_MAP: '{"omcp-admin":"admin","omcp-ops":"operator","other":"viewer"}',
  }));
  const rt = buildOidcRuntime(r.config!);
  assert.deepEqual(rt.resolveRoles({ groups: ["omcp-admin", "unknown", "omcp-ops"] }).sort(), ["admin", "operator"]);
});

test("buildOidcRuntime.resolveRoles — dotted claim path (Keycloak realm_access.roles shape)", () => {
  const r = resolveOidcConfig(envOf({
    OMCP_OIDC_ISSUER: "https://idp.test", OMCP_OIDC_CLIENT_ID: "c",
    OMCP_OIDC_REDIRECT_URI: "https://app.test/cb",
    OMCP_OIDC_ROLES_CLAIM: "realm_access.roles",
    OMCP_OIDC_ROLE_MAP: '{"omcp-admin":"admin"}',
  }));
  const rt = buildOidcRuntime(r.config!);
  assert.deepEqual(rt.resolveRoles({ realm_access: { roles: ["omcp-admin"] } }), ["admin"]);
});

test("buildOidcRuntime.resolveRoles — scalar string claim value still maps", () => {
  const r = resolveOidcConfig(envOf({
    OMCP_OIDC_ISSUER: "https://idp.test", OMCP_OIDC_CLIENT_ID: "c",
    OMCP_OIDC_REDIRECT_URI: "https://app.test/cb",
    OMCP_OIDC_ROLES_CLAIM: "role",
    OMCP_OIDC_ROLE_MAP: '{"sso-admin":"admin"}',
  }));
  const rt = buildOidcRuntime(r.config!);
  assert.deepEqual(rt.resolveRoles({ role: "sso-admin" }), ["admin"]);
});

test("buildOidcRuntime.resolveRoles — missing claim path yields empty roles (least privilege)", () => {
  const r = resolveOidcConfig(envOf({
    OMCP_OIDC_ISSUER: "https://idp.test", OMCP_OIDC_CLIENT_ID: "c",
    OMCP_OIDC_REDIRECT_URI: "https://app.test/cb",
    OMCP_OIDC_ROLE_MAP: '{"x":"admin"}',
  }));
  const rt = buildOidcRuntime(r.config!);
  assert.deepEqual(rt.resolveRoles({ sub: "alice" }), []);
});

test("buildOidcRuntime.resolveRoles — deduplicates when multiple claim values map to same role", () => {
  const r = resolveOidcConfig(envOf({
    OMCP_OIDC_ISSUER: "https://idp.test", OMCP_OIDC_CLIENT_ID: "c",
    OMCP_OIDC_REDIRECT_URI: "https://app.test/cb",
    OMCP_OIDC_ROLE_MAP: '{"a":"admin","b":"admin"}',
  }));
  const rt = buildOidcRuntime(r.config!);
  assert.deepEqual(rt.resolveRoles({ groups: ["a", "b"] }), ["admin"]);
});
