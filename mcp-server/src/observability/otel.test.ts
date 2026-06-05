import { test } from "node:test";
import assert from "node:assert/strict";

import {
  initOtel,
  isOtelEnabled,
  parseOtelHeaders,
  otelStatus,
  _resetOtelForTests,
} from "./otel.js";

test("isOtelEnabled — accepts true/1/yes/on (any case), rejects others", () => {
  for (const v of ["true", "1", "yes", "on", "TRUE", "Yes", "ON"]) {
    assert.equal(isOtelEnabled({ OMCP_OTEL_ENABLED: v }), true, v);
  }
  for (const v of ["", "false", "0", "no", "off", "anything-else"]) {
    assert.equal(isOtelEnabled({ OMCP_OTEL_ENABLED: v }), false, v);
  }
  assert.equal(isOtelEnabled({}), false, "unset env");
});

test("parseOtelHeaders — splits comma-separated key=value pairs", () => {
  assert.deepEqual(parseOtelHeaders("a=1,b=2"), { a: "1", b: "2" });
  assert.deepEqual(parseOtelHeaders(" a = 1 , b = 2 "), { a: "1", b: "2" });
  // Value containing `=` is preserved
  assert.deepEqual(parseOtelHeaders("Authorization=Bearer abc=def"), {
    Authorization: "Bearer abc=def",
  });
  assert.equal(parseOtelHeaders(""), undefined);
  assert.equal(parseOtelHeaders(undefined), undefined);
  // Drops malformed entries silently rather than throwing
  assert.deepEqual(parseOtelHeaders("nokey,b=2"), { b: "2" });
});

test("initOtel — no-op when OMCP_OTEL_ENABLED is off", async () => {
  _resetOtelForTests();
  const r = await initOtel({ env: { OMCP_OTEL_ENABLED: undefined } as NodeJS.ProcessEnv });
  assert.equal(r.enabled, false);
  assert.match(r.reason ?? "", /OMCP_OTEL_ENABLED is off/);
});

test("initOtel — second call is idempotent (returns cached result)", async () => {
  _resetOtelForTests();
  const r1 = await initOtel({ env: { OMCP_OTEL_ENABLED: "false" } as NodeJS.ProcessEnv });
  const r2 = await initOtel({ env: { OMCP_OTEL_ENABLED: "true" } as NodeJS.ProcessEnv });
  // Second call MUST return the cached result, not re-init
  assert.equal(r1.enabled, false);
  assert.equal(r2.enabled, false, "second init returned cached disabled state");
  assert.deepEqual(otelStatus(), r1);
});

test("initOtel — failure to import OTel packages degrades to disabled, not throw", async () => {
  // We cannot easily simulate a missing dep in this sandbox, but we
  // confirm the contract: on init failure, the result has enabled=false
  // and a reason; nothing is thrown. With the actual deps installed the
  // happy path is exercised in integration tests.
  _resetOtelForTests();
  const r = await initOtel({ env: { OMCP_OTEL_ENABLED: "true" } as NodeJS.ProcessEnv });
  // Either it succeeded (deps present, enabled=true) or it failed
  // gracefully (enabled=false + reason). Both are acceptable.
  if (r.enabled) {
    assert.ok(r.endpoint, "endpoint must be set when enabled");
    assert.equal(r.serviceName, "observability-mcp");
  } else {
    assert.ok(r.reason, "must include a reason on failure");
  }
});
