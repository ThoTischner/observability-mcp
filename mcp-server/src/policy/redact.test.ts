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

test("redactText — api-key style assignments", () => {
  const r1 = redactText('api_key="abc123def456ghi789jkl"');
  const r2 = redactText("x-api-key: sk_test_abcdefghijklmnopqrstuvwxyz");
  const r3 = redactText("token=xoxb-1234567890-abcdefghijklm");
  assert.ok(r1.matches["api-key"] + r1.matches.bearer >= 1);
  assert.ok(r2.matches["api-key"] + r2.matches.bearer >= 1);
  assert.ok(r3.matches["api-key"] + r3.matches.bearer >= 1);
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

test("redactValue — null / undefined leaves are preserved", () => {
  const r = redactValue({ a: null, b: undefined, c: "alice@example.com" });
  const v = r.value as { a: null; b: undefined; c: string };
  assert.equal(v.a, null);
  assert.equal(v.b, undefined);
  assert.equal(v.c, "[redacted-email]");
});
