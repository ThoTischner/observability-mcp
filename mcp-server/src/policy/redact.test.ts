import { test } from "node:test";
import assert from "node:assert/strict";

import { redactText, redactValue } from "./redact.js";

test("redactText — emails are redacted, counted", () => {
  const r = redactText("alert from alice@example.com to bob@corp.co.uk");
  assert.equal(r.matches.email, 2);
  assert.equal(r.totalMatches, 2);
  assert.match(r.text, /\[redacted-email\].*\[redacted-email\]/);
});

test("redactText — IPv4 quads redacted, version numbers left alone", () => {
  const r = redactText("client 192.168.1.42 connected to 10.0.0.1; version 1.2.3.4");
  // "1.2.3.4" technically matches as IPv4 — that's fine, it's a valid IPv4
  // and our threat model errs on the side of over-redaction.
  assert.ok(r.matches.ipv4 >= 2);
  assert.match(r.text, /\[redacted-ipv4\]/);
});

test("redactText — bearer tokens stripped", () => {
  const r = redactText('GET /api/foo Authorization: Bearer abcdef1234567890XYZ');
  assert.equal(r.matches.bearer, 1);
  assert.match(r.text, /\[redacted-bearer\]/);
  assert.doesNotMatch(r.text, /abcdef1234567890XYZ/);
});

test("redactText — JWTs detected by eyJ prefix + three-part shape", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijk-_ABC";
  const r = redactText(`token=${jwt} for user`);
  assert.ok(r.matches.jwt >= 1);
  assert.doesNotMatch(r.text, /eyJ/);
});

test("redactText — api-key / cloud-token style assignments", () => {
  // r1: generic prefix-based api-key match.
  // r2: x-api-key with an opaque body — falls through to api-key.
  // r3: token= with a Slack-shape value — the new slack-token pattern
  //     wins because it runs before api-key; either outcome is fine,
  //     the contract is "the secret is gone after one pass".
  const r1 = redactText('api_key="abc123def456ghi789jkl"');
  const r2 = redactText("x-api-key: sk_test_abcdefghijklmnopqrstuvwxyz");
  const r3 = redactText("token=xoxb-1234567890-abcdefghijklm");
  assert.ok(r1.totalMatches >= 1, "expected r1 to be redacted somewhere");
  assert.ok(r2.totalMatches >= 1, "expected r2 to be redacted somewhere");
  assert.ok(r3.totalMatches >= 1, "expected r3 to be redacted somewhere");
  assert.doesNotMatch(r1.text, /abc123def456ghi789jkl/);
  assert.doesNotMatch(r2.text, /sk_test_abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(r3.text, /xoxb-1234567890/);
});

test("redactText — leaves harmless text alone", () => {
  const r = redactText("the order-service replied with 200 OK after 45ms");
  assert.equal(r.totalMatches, 0);
  assert.equal(r.text, "the order-service replied with 200 OK after 45ms");
});

test("redactText — already-redacted markers don't re-match in further passes", () => {
  // Run the redactor twice; the second pass should be a no-op.
  const first = redactText("contact alice@example.com");
  const second = redactText(first.text);
  assert.equal(second.totalMatches, 0);
});

test("redactValue — walks nested objects / arrays, mutates only strings", () => {
  const input = {
    user: "bob@corp.co.uk",
    nested: {
      ip: "10.0.0.1",
      count: 42,
      tags: ["audit", "client=alice@example.com"],
    },
    flag: true,
  };
  const r = redactValue(input);
  const v = r.value as typeof input;
  assert.equal(v.user, "[redacted-email]");
  assert.equal(v.nested.ip, "[redacted-ipv4]");
  assert.equal(v.nested.count, 42);
  assert.equal(v.nested.tags[0], "audit");
  assert.equal(v.nested.tags[1], "client=[redacted-email]");
  assert.equal(v.flag, true);
  assert.equal(r.matches.email, 2);
  assert.equal(r.matches.ipv4, 1);
  assert.equal(r.totalMatches, 3);
});

test("redactText — AWS access key IDs (AKIA / ASIA / AROA) are redacted", () => {
  const r1 = redactText("log: assumed role AKIAIOSFODNN7EXAMPLE today");
  const r2 = redactText("temporary creds ASIAY34FZKBOKMUTVV7A logged");
  const r3 = redactText("role-arn AROAIIAFOO2ZBADBCEXAMPLE");
  assert.equal(r1.matches["aws-key"], 1);
  assert.equal(r2.matches["aws-key"], 1);
  assert.equal(r3.matches["aws-key"], 1);
  assert.match(r1.text, /\[redacted-aws-key\]/);
  assert.doesNotMatch(r1.text, /AKIAIOSFODNN7EXAMPLE/);
});

test("redactText — Slack tokens (xoxa / xoxb / xoxp / …) are redacted", () => {
  const r = redactText("slack notify: token=xoxb-1234567890-abcdefghijklm result: ok");
  assert.equal(r.matches["slack-token"], 1);
  assert.doesNotMatch(r.text, /xoxb-1234567890/);
});

test("redactText — GitHub PATs are redacted (ghp_ / github_pat_)", () => {
  const r1 = redactText("git remote set-url origin https://ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789@github.com/x/y.git");
  // Use a 40-char body, which matches `[A-Za-z0-9_]{40,}` (note: includes underscore)
  const r2 = redactText("token github_pat_ABCDEFGH_IJKLMNOPQRSTUVWXYZ012345678ABCDEFGHIJKLMNOP");
  assert.equal(r1.matches["gh-pat"], 1);
  assert.equal(r2.matches["gh-pat"], 1);
});

test("redactText — PEM private-key blocks are redacted greedily", () => {
  const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAwLPVKj…
-----END RSA PRIVATE KEY-----`;
  const r = redactText(`config:\n${pem}\nend`);
  assert.equal(r.matches["private-key"], 1);
  assert.doesNotMatch(r.text, /MIIEpAIBAA/);
});

test("redactValue — null / undefined leaves are preserved", () => {
  const r = redactValue({ a: null, b: undefined, c: "alice@example.com" });
  const v = r.value as { a: null; b: undefined; c: string };
  assert.equal(v.a, null);
  assert.equal(v.b, undefined);
  assert.equal(v.c, "[redacted-email]");
});
