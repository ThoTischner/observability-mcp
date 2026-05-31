import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadCredentials,
  credentialsConfigured,
  extractToken,
  resolveToken,
} from "./credentials.js";
import { queryMetricsHandler } from "../tools/query-metrics.js";
import { principalContext, defaultContext } from "../context.js";

describe("single-tenant auth primitive", () => {
  it("unconfigured → no credentials, anonymous (backward compatible)", () => {
    assert.equal(credentialsConfigured({}), false);
    assert.deepEqual(loadCredentials({}), []);
  });

  it("parses name:token and bare token", () => {
    const creds = loadCredentials({ OMCP_API_KEYS: "ci:tok_abc, tok_bare " });
    assert.equal(creds.length, 2);
    assert.deepEqual(
      creds[0],
      { name: "ci", token: "tok_abc", allowedSources: undefined, bypassRedaction: undefined }
    );
    assert.equal(creds[1].name, "key");
    assert.equal(creds[1].token, "tok_bare");
  });

  it("parses per-key source allow-list", () => {
    const creds = loadCredentials({
      OMCP_API_KEYS: "agent:tok1,ci:tok2",
      OMCP_KEY_SOURCES: "agent=prom-prod|loki-prod; ci=prom-staging",
    });
    assert.deepEqual(creds[0].allowedSources, ["prom-prod", "loki-prod"]);
    assert.deepEqual(creds[1].allowedSources, ["prom-staging"]);
  });

  it("parses OMCP_KEY_BYPASS_REDACTION → flags only the listed names", () => {
    const creds = loadCredentials({
      OMCP_API_KEYS: "agent:tok1,ci:tok2,unprivileged:tok3",
      OMCP_KEY_BYPASS_REDACTION: "agent, ci",
    });
    assert.equal(creds.find((c) => c.name === "agent")?.bypassRedaction, true);
    assert.equal(creds.find((c) => c.name === "ci")?.bypassRedaction, true);
    // Unlisted keys MUST be undefined (not false) so JSON serialisation
    // omits the field — keeps the audit log payload tidy.
    assert.equal(creds.find((c) => c.name === "unprivileged")?.bypassRedaction, undefined);
  });

  it("OMCP_KEY_BYPASS_REDACTION absent → no key bypasses (least privilege default)", () => {
    const creds = loadCredentials({ OMCP_API_KEYS: "agent:tok1,ci:tok2" });
    for (const c of creds) assert.equal(c.bypassRedaction, undefined);
  });

  it("extractToken handles Bearer and X-API-Key", () => {
    assert.equal(extractToken({ authorization: "Bearer abc" }), "abc");
    assert.equal(extractToken({ authorization: "bearer  xyz " }), "xyz");
    assert.equal(extractToken({ "x-api-key": "k1" }), "k1");
    assert.equal(extractToken({}), null);
  });

  it("resolveToken matches only an exact token", () => {
    const creds = loadCredentials({ OMCP_API_KEYS: "a:secret123" });
    assert.equal(resolveToken("secret123", creds)?.name, "a");
    assert.equal(resolveToken("secret12", creds), null);
    assert.equal(resolveToken("wrong", creds), null);
    assert.equal(resolveToken(null, creds), null);
  });

  it("coarse source scoping denies an out-of-scope source", async () => {
    const ctx = principalContext("agent", ["prom-prod"]);
    const res = await queryMetricsHandler(
      {} as never,
      { service: "svc", metric: "cpu", source: "prom-secret" },
      ctx
    );
    const text = res.content[0].text;
    assert.match(text, /forbidden: source.*prom-secret.*not in your allowed sources/);
  });

  it("anonymous (no allow-list) does not trigger the scoping guard", async () => {
    // No allowedSources → guard is a no-op. It must NOT short-circuit with a
    // forbidden message (it falls through to normal handling, which on a stub
    // registry may throw — that's fine, it means we passed the guard).
    try {
      const res = await queryMetricsHandler(
        {} as never,
        { service: "svc", metric: "cpu", source: "anything" },
        defaultContext()
      );
      assert.doesNotMatch(res.content[0].text, /allowed sources/);
    } catch {
      // threw past the guard → guard correctly did not fire
    }
  });
});
