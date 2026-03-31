import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateDuration, validateServiceName, sanitizeLabelValue, errorResponse } from "./validation.js";

describe("validateDuration", () => {
  it("accepts valid durations", () => {
    assert.equal(validateDuration("5m"), null);
    assert.equal(validateDuration("1h"), null);
    assert.equal(validateDuration("24h"), null);
    assert.equal(validateDuration("7d"), null);
    assert.equal(validateDuration("30m"), null);
    assert.equal(validateDuration("365d"), null);
  });

  it("rejects invalid durations", () => {
    assert.ok(validateDuration("") !== null);
    assert.ok(validateDuration("5") !== null);
    assert.ok(validateDuration("m") !== null);
    assert.ok(validateDuration("5s") !== null);       // seconds not supported
    assert.ok(validateDuration("5min") !== null);      // only single-char units
    assert.ok(validateDuration("-5m") !== null);        // no negative
    assert.ok(validateDuration("5.5m") !== null);       // no decimals
    assert.ok(validateDuration("5m 1h") !== null);      // no spaces
    assert.ok(validateDuration("abc") !== null);
  });

  it("returns helpful error message", () => {
    const err = validateDuration("5s");
    assert.ok(err!.includes("Invalid duration"));
    assert.ok(err!.includes("5m"));  // example in message
  });
});

describe("sanitizeLabelValue", () => {
  it("accepts valid label values", () => {
    assert.equal(sanitizeLabelValue("api-gateway"), "api-gateway");
    assert.equal(sanitizeLabelValue("payment_service"), "payment_service");
    assert.equal(sanitizeLabelValue("svc.prod.us-east-1"), "svc.prod.us-east-1");
    assert.equal(sanitizeLabelValue("host:8080"), "host:8080");
    assert.equal(sanitizeLabelValue("a"), "a");
  });

  it("rejects empty string", () => {
    assert.equal(sanitizeLabelValue(""), null);
  });

  it("rejects strings over 128 characters", () => {
    assert.equal(sanitizeLabelValue("a".repeat(129)), null);
  });

  it("accepts exactly 128 characters", () => {
    assert.equal(sanitizeLabelValue("a".repeat(128)), "a".repeat(128));
  });

  it("rejects injection attempts", () => {
    assert.equal(sanitizeLabelValue('service"}[5m])'), null);  // PromQL injection
    assert.equal(sanitizeLabelValue("service`rm -rf`"), null); // command injection
    assert.equal(sanitizeLabelValue("svc;drop"), null);        // semicolon
    assert.equal(sanitizeLabelValue("svc name"), null);        // spaces
    assert.equal(sanitizeLabelValue('svc"name'), null);        // quotes
    assert.equal(sanitizeLabelValue("svc'name"), null);        // single quotes
    assert.equal(sanitizeLabelValue("svc{name}"), null);       // braces
    assert.equal(sanitizeLabelValue("svc|name"), null);        // pipe
  });
});

describe("validateServiceName", () => {
  it("returns null for valid service names", () => {
    assert.equal(validateServiceName("api-gateway"), null);
    assert.equal(validateServiceName("payment-service"), null);
    assert.equal(validateServiceName("my_svc_v2"), null);
  });

  it("returns error for invalid service names", () => {
    assert.ok(validateServiceName("") !== null);
    assert.ok(validateServiceName("svc name") !== null);
    assert.ok(validateServiceName('svc"injection') !== null);
  });

  it("returns helpful error message", () => {
    const err = validateServiceName("bad name!");
    assert.ok(err!.includes("Invalid service name"));
    assert.ok(err!.includes("alphanumeric"));
  });
});

describe("errorResponse", () => {
  it("returns MCP error format", () => {
    const res = errorResponse("something went wrong");
    assert.equal(res.isError, true);
    assert.equal(res.content.length, 1);
    assert.equal(res.content[0].type, "text");
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.error, "something went wrong");
  });
});
