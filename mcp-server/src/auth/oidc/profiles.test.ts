import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getProfile,
  profileNames,
  DEFAULT_PROFILE,
} from "./profiles.js";

test("profiles: getProfile returns known profiles, case-insensitive", () => {
  assert.equal(getProfile("github")?.name, "github");
  assert.equal(getProfile("Github")?.name, "github");
  assert.equal(getProfile("MICROSOFT-ENTRA")?.name, "microsoft-entra");
});

test("profiles: getProfile returns undefined for unknown / empty", () => {
  assert.equal(getProfile(undefined), undefined);
  assert.equal(getProfile(""), undefined);
  assert.equal(getProfile("nope"), undefined);
});

test("profiles: profileNames lists the 6 baked-in profiles", () => {
  const names = profileNames();
  for (const expected of [
    "generic",
    "keycloak",
    "github",
    "google",
    "microsoft-entra",
    "okta",
  ]) {
    assert.ok(names.includes(expected), `missing profile ${expected}`);
  }
});

test("profiles: DEFAULT_PROFILE is generic and preserves the pre-F6 defaults", () => {
  assert.equal(DEFAULT_PROFILE.name, "generic");
  assert.equal(DEFAULT_PROFILE.scopes, "openid profile email");
  assert.equal(DEFAULT_PROFILE.rolesClaim, "groups");
  assert.equal(DEFAULT_PROFILE.tenantClaim, "");
});

test("profiles: vendor-specific tenant claims match the IdP-native key", () => {
  // hd = hosted domain (Google) — useful as a tenant key for
  // multi-org Workspace deployments
  assert.equal(getProfile("google")?.tenantClaim, "hd");
  // tid = tenant id (Entra-native)
  assert.equal(getProfile("microsoft-entra")?.tenantClaim, "tid");
});

test("profiles: Okta scopes include 'groups' so the claim is actually returned", () => {
  // Okta's group claim is only emitted when 'groups' is in the
  // requested scope set; profile must include it as a default.
  assert.match(getProfile("okta")?.scopes ?? "", /\bgroups\b/);
});

test("profiles: each profile has a docs path", () => {
  for (const name of profileNames()) {
    const p = getProfile(name)!;
    assert.ok(p.docs, `profile ${name} has no docs path`);
    assert.match(p.docs, /^docs\//, `profile ${name} docs should be a repo-relative path`);
  }
});
