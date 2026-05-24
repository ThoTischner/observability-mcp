import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, parseSseJson, scoreCorrectness } from "./benchmark-rca.mjs";

test("parseArgs — kv with = and bare flags", () => {
  const a = parseArgs(["--mode=topology", "--iterations=5", "--verbose"]);
  assert.equal(a.mode, "topology");
  assert.equal(a.iterations, "5");
  assert.equal(a.verbose, "true");
});

test("parseArgs — ignores positional args", () => {
  const a = parseArgs(["foo", "--mode=baseline", "bar"]);
  assert.deepEqual(Object.keys(a).sort(), ["mode"]);
});

test("parseSseJson — handles plain JSON", () => {
  const r = parseSseJson('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
  assert.equal(r.result.ok, true);
});

test("parseSseJson — handles SSE-framed JSON", () => {
  const r = parseSseJson('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"x":42}}\n\n');
  assert.equal(r.result.x, 42);
});

test("parseSseJson — null on garbage", () => {
  assert.equal(parseSseJson(""), null);
  assert.equal(parseSseJson("not json"), null);
});

test("scoreCorrectness — true when the target service AND an error signal are named", () => {
  assert.equal(
    scoreCorrectness("Root cause: payment-service is throwing 5xx errors after the deploy."),
    true,
  );
  assert.equal(
    scoreCorrectness("Payment-service shows an error spike of 41% over the last 5 minutes."),
    true,
  );
});

test("scoreCorrectness — false when the target service is missing", () => {
  assert.equal(
    scoreCorrectness("The order-service is throwing 5xx errors."),
    false,
  );
});

test("scoreCorrectness — false when no error signal is mentioned", () => {
  assert.equal(
    scoreCorrectness("payment-service has elevated CPU usage."),
    false,
  );
});

test("scoreCorrectness — handles empty / null answers", () => {
  assert.equal(scoreCorrectness(""), false);
  assert.equal(scoreCorrectness(null), false);
  assert.equal(scoreCorrectness(undefined), false);
});

test("scoreCorrectness — accepts spaces or underscores in place of dashes (Payment Service ≡ payment-service)", () => {
  assert.equal(
    scoreCorrectness("Root cause: Payment Service is throwing 5xx errors after the deploy."),
    true,
  );
  assert.equal(
    scoreCorrectness("payment_service has an error spike."),
    true,
  );
});
