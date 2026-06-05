import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  validateDcrRequest,
  mintRegistration,
  appendRegistration,
  loadRegistrations,
  toResponse,
  dcrEnabled,
  dcrStorePath,
  DcrValidationError,
} from "./dcr.js";

function tmp(): string {
  return join(mkdtempSync(join(tmpdir(), "dcr-")), "dcr.json");
}

test("dcrEnabled — true/1/yes/on (any case), unset = false", () => {
  for (const v of ["true", "1", "yes", "on", "TRUE", "Yes"]) {
    assert.equal(dcrEnabled({ OMCP_OIDC_DCR_ENABLED: v }), true, v);
  }
  for (const v of ["", "false", "0", "anything-else"]) {
    assert.equal(dcrEnabled({ OMCP_OIDC_DCR_ENABLED: v }), false, v);
  }
  assert.equal(dcrEnabled({}), false);
});

test("dcrStorePath — defaults to /tmp/oidc-dcr.json, env override wins", () => {
  assert.equal(dcrStorePath({}), "/tmp/oidc-dcr.json");
  assert.equal(
    dcrStorePath({ OMCP_OIDC_DCR_STORE: "/var/lib/dcr.json" }),
    "/var/lib/dcr.json",
  );
});

test("validateDcrRequest — requires non-empty redirect_uris", () => {
  assert.throws(
    () => validateDcrRequest({} as never),
    DcrValidationError,
  );
  assert.throws(
    () => validateDcrRequest({ redirect_uris: [] }),
    DcrValidationError,
  );
});

test("validateDcrRequest — rejects http:// for non-loopback hosts", () => {
  assert.throws(
    () => validateDcrRequest({ redirect_uris: ["http://example.com/cb"] }),
    /must use https/,
  );
  assert.doesNotThrow(() =>
    validateDcrRequest({ redirect_uris: ["http://localhost:5173/cb"] }),
  );
  assert.doesNotThrow(() =>
    validateDcrRequest({ redirect_uris: ["http://127.0.0.1:5173/cb"] }),
  );
});

test("validateDcrRequest — accepts https:// always", () => {
  const v = validateDcrRequest({
    redirect_uris: ["https://app.example.com/oauth/callback"],
  });
  assert.deepEqual(v.redirect_uris, ["https://app.example.com/oauth/callback"]);
});

test("validateDcrRequest — defaults for grant_types/response_types/auth_method", () => {
  const v = validateDcrRequest({ redirect_uris: ["https://x/cb"] });
  assert.deepEqual(v.grant_types, ["authorization_code"]);
  assert.deepEqual(v.response_types, ["code"]);
  assert.equal(v.token_endpoint_auth_method, "client_secret_basic");
});

test("validateDcrRequest — preserves explicit values", () => {
  const v = validateDcrRequest({
    redirect_uris: ["https://x/cb"],
    grant_types: ["refresh_token"],
    response_types: ["code id_token"],
    token_endpoint_auth_method: "none",
    client_name: "Claude.ai",
    scope: "openid profile",
  });
  assert.deepEqual(v.grant_types, ["refresh_token"]);
  assert.equal(v.token_endpoint_auth_method, "none");
  assert.equal(v.client_name, "Claude.ai");
  assert.equal(v.scope, "openid profile");
});

test("mintRegistration — issues client_id (UUID), client_secret (base64url), no secret for 'none' auth", () => {
  const now = new Date("2026-06-05T20:00:00Z");
  const validated = validateDcrRequest({ redirect_uris: ["https://x/cb"] });
  const reg = mintRegistration(validated, "10.0.0.1", { now: () => now });
  assert.match(reg.client_id, /^[0-9a-f-]{36}$/);
  assert.ok(reg.client_secret && reg.client_secret.length > 30);
  assert.equal(reg.client_id_issued_at, Math.floor(now.getTime() / 1000));
  assert.equal(reg.client_secret_expires_at, 0);
  assert.ok(reg.registration_access_token && reg.registration_access_token.length > 30);
  assert.equal(reg._meta.sourceIp, "10.0.0.1");
  assert.equal(reg._meta.createdAtIso, now.toISOString());

  // Public client (PKCE, no secret) — RFC 7591 §3.2.1
  const pub = mintRegistration(
    validateDcrRequest({
      redirect_uris: ["https://x/cb"],
      token_endpoint_auth_method: "none",
    }),
    "10.0.0.1",
    { now: () => now },
  );
  assert.equal(pub.client_secret, undefined);
});

test("appendRegistration + loadRegistrations — round-trips, file is 0600", async () => {
  const store = tmp();
  const validated = validateDcrRequest({ redirect_uris: ["https://x/cb"] });
  const reg = mintRegistration(validated, "10.0.0.7");
  await appendRegistration(store, reg);
  const loaded = await loadRegistrations(store);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.client_id, reg.client_id);
  // File-mode check — DCR registrations contain secrets.
  const mode = statSync(store).mode & 0o777;
  assert.equal(mode, 0o600, `expected mode 0o600 got ${mode.toString(8)}`);
});

test("loadRegistrations — missing file returns []", async () => {
  const store = tmp();
  // No file written.
  const loaded = await loadRegistrations(store);
  assert.deepEqual(loaded, []);
});

test("toResponse — strips internal _meta so secrets don't leak source IP", () => {
  const validated = validateDcrRequest({ redirect_uris: ["https://x/cb"] });
  const reg = mintRegistration(validated, "10.0.0.7");
  const response = toResponse(reg) as unknown as Record<string, unknown>;
  assert.equal(response._meta, undefined);
  assert.equal(response.client_id, reg.client_id);
  assert.equal(response.client_secret, reg.client_secret);
});

test("appendRegistration — atomic write (tmp+rename) survives a missing parent dir", async () => {
  const parent = mkdtempSync(join(tmpdir(), "dcr-parent-"));
  const store = join(parent, "sub", "nested", "dcr.json");
  const reg = mintRegistration(
    validateDcrRequest({ redirect_uris: ["https://x/cb"] }),
    "10.0.0.7",
  );
  await appendRegistration(store, reg);
  const onDisk = JSON.parse(readFileSync(store, "utf8"));
  assert.equal(onDisk.length, 1);
});
