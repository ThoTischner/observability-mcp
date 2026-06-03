import { test } from "node:test";
import assert from "node:assert/strict";

import { applyBudgetDecision } from "./charge.js";
import type { CheckResult } from "./token-budget.js";

function decision(over: Partial<CheckResult>): CheckResult {
  return {
    allowed: false,
    used: 0,
    limit: 1000,
    retryAfterSeconds: 3600,
    freedAtRetry: 100,
    ...over,
  };
}

const sampleResult = () => ({ content: [{ text: "original tool output" }] });

test("applyBudgetDecision — passes the result through when allowed", () => {
  const r = sampleResult();
  const out = applyBudgetDecision(r, decision({ allowed: true }), 50, "query_logs");
  assert.equal(out, r, "exact passthrough when allowed");
});

test("applyBudgetDecision — passes through when uncapped (limit === 0)", () => {
  const r = sampleResult();
  const out = applyBudgetDecision(r, decision({ allowed: false, limit: 0 }), 50_000, "query_logs");
  assert.equal(out.content[0].text, "original tool output");
});

test("applyBudgetDecision — cumulative exceed emits OMCP_TOKEN_BUDGET_EXCEEDED", () => {
  // Tokens fit a single request (<= limit) but cumulative pushes over.
  const r = sampleResult();
  const out = applyBudgetDecision(
    r,
    decision({ used: 950, limit: 1000, retryAfterSeconds: 7200, freedAtRetry: 200 }),
    100,
    "query_logs",
  );
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.error, "OMCP_TOKEN_BUDGET_EXCEEDED");
  assert.equal(body.tool, "query_logs");
  assert.equal(body.used, 950);
  assert.equal(body.limit, 1000);
  assert.equal(body.requested, 100);
  assert.equal(body.retryAfterSeconds, 7200);
  assert.equal(body.freedAtRetry, 200);
  assert.match(body.message, /Daily token budget exceeded/);
  assert.match(body.message, /Try again in ~2h/);
});

test("applyBudgetDecision — single request > limit emits the DISTINCT OMCP_TOKEN_REQUEST_EXCEEDS_BUDGET", () => {
  // The whole point of the distinct code: an agent that sees this
  // must NOT retry — waiting can never fit a request larger than the
  // entire daily cap. retryAfterSeconds is forced to 0 so naive
  // backoff loops terminate.
  const r = sampleResult();
  const out = applyBudgetDecision(
    r,
    decision({ used: 0, limit: 1000, retryAfterSeconds: 3600, freedAtRetry: 0 }),
    5000, // request > limit
    "query_metrics",
  );
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.error, "OMCP_TOKEN_REQUEST_EXCEEDS_BUDGET");
  assert.equal(body.tool, "query_metrics");
  assert.equal(body.requested, 5000);
  assert.equal(body.limit, 1000);
  assert.equal(body.retryAfterSeconds, 0, "retry-loop killer: 0 instead of inherited 3600");
  assert.match(body.message, /larger than the entire daily budget/);
  assert.match(body.message, /Retrying won't help/);
});

test("applyBudgetDecision — boundary: request == limit is NOT the request-exceeds-cap code", () => {
  // A request exactly equal to the cap can theoretically succeed on
  // an empty bucket — it's the cumulative-exceeded path, not the
  // unconditional-deny path.
  const r = sampleResult();
  const out = applyBudgetDecision(
    r,
    decision({ used: 100, limit: 1000 }),
    1000,
    "query_logs",
  );
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.error, "OMCP_TOKEN_BUDGET_EXCEEDED");
});

test("applyBudgetDecision — preserves additional content entries past the first", () => {
  const r = {
    content: [
      { text: "first", extraField: 42 },
      { text: "second" },
      { text: "third" },
    ],
  };
  const out = applyBudgetDecision(r, decision({}), 10, "t");
  assert.equal(out.content.length, 3);
  // First entry's text replaced; its other fields (extraField) preserved.
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.error, "OMCP_TOKEN_BUDGET_EXCEEDED");
  assert.equal((out.content[0] as { extraField: number }).extraField, 42);
  // Trailing entries pass through verbatim.
  assert.equal(out.content[1].text, "second");
  assert.equal(out.content[2].text, "third");
});
