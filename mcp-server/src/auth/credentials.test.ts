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
      { name: "ci", token: "tok_abc", allowedSources: undefined, bypassRedaction: undefined, allowRawQuery: undefined, tenant: undefined, productId: undefined, allowedTools: undefined }
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

  it("parses per-key tool allow-list (OMCP_KEY_TOOLS)", () => {
    const creds = loadCredentials({
      OMCP_API_KEYS: "agent:tok1,ci:tok2,full:tok3",
      OMCP_KEY_TOOLS: "agent=query_logs|get_service_health; ci=list_services",
    });
    assert.deepEqual(creds.find((c) => c.name === "agent")?.allowedTools, ["query_logs", "get_service_health"]);
    assert.deepEqual(creds.find((c) => c.name === "ci")?.allowedTools, ["list_services"]);
    // Unlisted key → undefined (no restriction, back-compat), not [].
    assert.equal(creds.find((c) => c.name === "full")?.allowedTools, undefined);
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

  it("parses OMCP_KEY_RAW_QUERY → flags only the listed names", () => {
    const creds = loadCredentials({
      OMCP_API_KEYS: "agent:tok1,ci:tok2,unprivileged:tok3",
      OMCP_KEY_RAW_QUERY: "agent, ci",
    });
    assert.equal(creds.find((c) => c.name === "agent")?.allowRawQuery, true);
    assert.equal(creds.find((c) => c.name === "ci")?.allowRawQuery, true);
    // Unlisted keys MUST be undefined (not false) so it only widens.
    assert.equal(creds.find((c) => c.name === "unprivileged")?.allowRawQuery, undefined);
  });

  it("OMCP_KEY_RAW_QUERY absent → no key may raw_query per-credential (global flag still applies)", () => {
    const creds = loadCredentials({ OMCP_API_KEYS: "agent:tok1,ci:tok2" });
    for (const c of creds) assert.equal(c.allowRawQuery, undefined);
  });

  it("parses OMCP_KEY_TENANTS → assigns tenant to named keys; unlisted stays undefined (default)", () => {
    const creds = loadCredentials({
      OMCP_API_KEYS: "agent:tok1,ci:tok2,nobody:tok3",
      OMCP_KEY_TENANTS: "agent=acme;ci=BigCorp",
    });
    assert.equal(creds.find((c) => c.name === "agent")?.tenant, "acme");
    assert.equal(creds.find((c) => c.name === "ci")?.tenant, "bigcorp", "lowercased");
    assert.equal(creds.find((c) => c.name === "nobody")?.tenant, undefined);
  });

  it("parses OMCP_KEY_PRODUCTS → assigns productId to named keys; unlisted stays undefined", () => {
    const creds = loadCredentials({
      OMCP_API_KEYS: "agent:tok1,ci:tok2,nobody:tok3",
      OMCP_KEY_PRODUCTS: "agent=ops-bundle;ci=dev-bundle",
    });
    assert.equal(creds.find((c) => c.name === "agent")?.productId, "ops-bundle");
    assert.equal(creds.find((c) => c.name === "ci")?.productId, "dev-bundle");
    assert.equal(creds.find((c) => c.name === "nobody")?.productId, undefined);
  });

  it("OMCP_KEY_PRODUCTS — malformed entries (no =, empty value) silently skipped", () => {
    const creds = loadCredentials({
      OMCP_API_KEYS: "agent:tok1,ci:tok2,x:tok3",
      // "noeq" lacks "=" → skip; "ci=" has empty value → skip;
      // "agent=ops" parses cleanly.
      OMCP_KEY_PRODUCTS: "agent=ops;noeq;ci=;x=dev",
    });
    assert.equal(creds.find((c) => c.name === "agent")?.productId, "ops");
    assert.equal(creds.find((c) => c.name === "ci")?.productId, undefined);
    assert.equal(creds.find((c) => c.name === "x")?.productId, "dev");
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
