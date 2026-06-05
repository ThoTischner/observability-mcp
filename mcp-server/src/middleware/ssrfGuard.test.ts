import { test } from "node:test";
import assert from "node:assert/strict";

import { checkOutboundUrl, ssrfGuardFromEnv } from "./ssrfGuard.js";

const STRICT = { allowPrivateBackends: false };
const LAX = { allowPrivateBackends: true };

test("ssrfGuardFromEnv: defaults strict, opts in on truthy", () => {
  assert.equal(ssrfGuardFromEnv({}).allowPrivateBackends, false);
  for (const v of ["1", "true", "yes", "on", "TRUE"]) {
    assert.equal(ssrfGuardFromEnv({ OMCP_ALLOW_PRIVATE_BACKENDS: v }).allowPrivateBackends, true, v);
  }
  for (const v of ["", "0", "false", "no", "off"]) {
    assert.equal(ssrfGuardFromEnv({ OMCP_ALLOW_PRIVATE_BACKENDS: v }).allowPrivateBackends, false, v);
  }
});

test("rejects malformed URLs", () => {
  const r = checkOutboundUrl("not-a-url", STRICT);
  assert.equal(r.allow, false);
});

test("rejects non-http(s) schemes", () => {
  assert.equal(checkOutboundUrl("ftp://example.com", STRICT).allow, false);
  assert.equal(checkOutboundUrl("file:///etc/passwd", STRICT).allow, false);
});

test("rejects AWS cloud-metadata IP regardless of allowPrivateBackends", () => {
  for (const cfg of [STRICT, LAX]) {
    const r = checkOutboundUrl("http://169.254.169.254/latest/meta-data/", cfg);
    assert.equal(r.allow, false, JSON.stringify(cfg));
    assert.match(r.reason ?? "", /cloud-metadata/);
  }
});

test("rejects private IPv4 ranges in strict mode", () => {
  for (const url of [
    "http://10.0.0.1/",
    "http://172.16.0.5/",
    "http://172.31.255.1/",
    "http://192.168.1.1/",
    "http://127.0.0.1:9090/",
    "http://169.254.10.1/",
  ]) {
    const r = checkOutboundUrl(url, STRICT);
    assert.equal(r.allow, false, url);
  }
});

test("ACCEPTS private IPs when allowPrivateBackends=true (in-cluster opt-out)", () => {
  for (const url of [
    "http://prometheus.monitoring.svc.cluster.local:9090/",
    "http://10.0.0.1:9090/",
    "http://172.20.0.1:9090/",
  ]) {
    assert.equal(checkOutboundUrl(url, LAX).allow, true, url);
  }
});

test("accepts public IPv4 / hostnames in strict mode", () => {
  for (const url of [
    "https://prometheus.example.com/api/v1/query",
    "https://8.8.8.8/x",
    "https://1.1.1.1/x",
  ]) {
    assert.equal(checkOutboundUrl(url, STRICT).allow, true, url);
  }
});

test("rejects IPv6 loopback + link-local + unique-local in strict mode", () => {
  for (const url of [
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
  ]) {
    assert.equal(checkOutboundUrl(url, STRICT).allow, false, url);
  }
});

test("172.{16-31} private range edge cases", () => {
  // 172.15 is public; 172.16-172.31 is private; 172.32 is public.
  assert.equal(checkOutboundUrl("http://172.15.0.1/", STRICT).allow, true);
  assert.equal(checkOutboundUrl("http://172.16.0.1/", STRICT).allow, false);
  assert.equal(checkOutboundUrl("http://172.31.0.1/", STRICT).allow, false);
  assert.equal(checkOutboundUrl("http://172.32.0.1/", STRICT).allow, true);
});

test("uppercase IPv6 hostnames are still caught", () => {
  // URL parser lowercases hostnames, but we still test for safety.
  assert.equal(checkOutboundUrl("http://[FE80::1]/", STRICT).allow, false);
});
