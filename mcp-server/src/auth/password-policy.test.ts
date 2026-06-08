import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  validatePassword,
  passwordPolicyFromEnv,
  passwordPolicyDisabledFromEnv,
  DEFAULT_PASSWORD_POLICY,
  COMMON_PASSWORD_DENYLIST,
} from "./password-policy.js";

test("a strong password passes the default policy", () => {
  const r = validatePassword("Tr0ub4dour&3xtra");
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("too-short password is rejected with a length error", () => {
  const r = validatePassword("Ab1!xy");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("at least 12")));
});

test("insufficient character classes is rejected", () => {
  // 16 lowercase letters — long enough, but only one class.
  const r = validatePassword("abcdefghijklmnop");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("at least 3 of")));
});

test("two classes still fails the default min of three", () => {
  const r = validatePassword("abcdefghijkl1234"); // lower + digit only
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("at least 3 of")));
});

test("exactly three classes passes", () => {
  const r = validatePassword("abcdefghABCD1234"); // lower+upper+digit = 3
  assert.equal(r.ok, true);
});

test("common-password denylist is enforced case-insensitively", () => {
  // Permissive length/classes so ONLY the denylist can reject — the
  // denylist matches the whole password exactly (case-insensitively).
  const permissive = { minLength: 1, maxLength: 1024, minClasses: 1, denylistEnabled: true };
  const r = validatePassword("PaSsWoRd123", permissive);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("denylist")));
});

test("denylist entries themselves are all rejected when long enough is waived", () => {
  // Sanity: the canonical app-specific entries are present.
  assert.ok(COMMON_PASSWORD_DENYLIST.has("observability-mcp"));
  assert.ok(COMMON_PASSWORD_DENYLIST.has("prometheus"));
});

test("password containing the username is rejected", () => {
  const r = validatePassword("alice-Secret-99x", DEFAULT_PASSWORD_POLICY, "alice");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("username")));
});

test("short usernames (<3 chars) do not trigger the username check", () => {
  // "al" is too short to meaningfully match; password is otherwise strong.
  const r = validatePassword("alXyZ12345678!", DEFAULT_PASSWORD_POLICY, "al");
  assert.equal(r.ok, true);
});

test("code-point length counts multibyte characters as one", () => {
  // 11 emoji = 11 code points < 12 → too short despite a large byte length.
  const eleven = "😀".repeat(11);
  assert.equal(validatePassword(eleven).ok, false);
  // 12 of them clears length; emoji count as the "symbol" class only → 1 class.
  const twelve = "😀".repeat(12);
  const r = validatePassword(twelve);
  assert.equal(r.ok, false); // fails on classes, not length
  assert.ok(r.errors.some((e) => e.includes("at least 3 of")));
  assert.ok(!r.errors.some((e) => e.includes("at least 12")));
});

test("over-long password is rejected (scrypt DoS guard)", () => {
  const r = validatePassword("Aa1!".repeat(300)); // 1200 chars > 1024
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("at most")));
});

test("disabling the denylist lets a denylisted password through", () => {
  const permissive = { minLength: 1, maxLength: 1024, minClasses: 1, denylistEnabled: false };
  // 'password123' is on the denylist; with it disabled only length/classes
  // apply, which this permissive policy waives.
  assert.equal(validatePassword("password123", permissive).ok, true);
});

test("passwordPolicyFromEnv parses overrides and ignores bad input", () => {
  const p = passwordPolicyFromEnv({
    OMCP_PASSWORD_MIN_LENGTH: "16",
    OMCP_PASSWORD_MIN_CLASSES: "bad",
    OMCP_PASSWORD_DENYLIST_DISABLED: "true",
  } as NodeJS.ProcessEnv);
  assert.equal(p.minLength, 16);
  assert.equal(p.minClasses, DEFAULT_PASSWORD_POLICY.minClasses); // bad → default
  assert.equal(p.denylistEnabled, false);
});

test("passwordPolicyDisabledFromEnv recognises truthy values", () => {
  assert.equal(passwordPolicyDisabledFromEnv({ OMCP_PASSWORD_POLICY_DISABLED: "1" } as NodeJS.ProcessEnv), true);
  assert.equal(passwordPolicyDisabledFromEnv({ OMCP_PASSWORD_POLICY_DISABLED: "false" } as NodeJS.ProcessEnv), false);
  assert.equal(passwordPolicyDisabledFromEnv({} as NodeJS.ProcessEnv), false);
});

test("CLI hash-password.mjs stays in sync with the canonical policy", () => {
  // The CLI deliberately duplicates the policy to stay dependency-free
  // (same precedent as the scrypt params). This guard fails loudly if the
  // two drift: every canonical denylist entry + the defaults must appear
  // verbatim in the script. (__dirname → mcp-server/src/auth)
  const here = dirname(fileURLToPath(import.meta.url));
  const cliPath = join(here, "..", "..", "..", "scripts", "hash-password.mjs");
  const cli = readFileSync(cliPath, "utf8");
  for (const entry of COMMON_PASSWORD_DENYLIST) {
    assert.ok(cli.includes(`"${entry}"`), `CLI denylist is missing "${entry}"`);
  }
  assert.ok(cli.includes(`"OMCP_PASSWORD_MIN_LENGTH", ${DEFAULT_PASSWORD_POLICY.minLength}`), "CLI minLength default drifted");
  assert.ok(cli.includes(`"OMCP_PASSWORD_MIN_CLASSES", ${DEFAULT_PASSWORD_POLICY.minClasses}`), "CLI minClasses default drifted");
  assert.ok(cli.includes(`PW_MAX_LENGTH = ${DEFAULT_PASSWORD_POLICY.maxLength}`), "CLI maxLength default drifted");
});

test("multiple violations are all reported", () => {
  const r = validatePassword("admin"); // short, 1 class, on denylist
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 2);
});
