import { test } from "node:test";
import assert from "node:assert/strict";

import { IncidentDeduper, anomalyHash } from "./dedup.js";

const A = { service: "payment-service", metric: "cpu", severity: "warning" };
const B = { service: "payment-service", metric: "errors", severity: "warning" };
const C = { service: "payment-service", metric: "cpu", severity: "critical" };

test("anomalyHash — distinct triples produce distinct hashes (no false collapse)", () => {
  assert.notEqual(anomalyHash(A), anomalyHash(B));
  assert.notEqual(anomalyHash(A), anomalyHash(C));
  assert.equal(anomalyHash(A), anomalyHash({ ...A }));
});

test("IncidentDeduper — first sighting is NOT a duplicate; second sighting within TTL IS", () => {
  let now = 1_000_000;
  const d = new IncidentDeduper(60_000, () => now);
  assert.equal(d.isDuplicate(A), false);
  d.markReported(A);
  // 30 seconds later — still inside the 60s TTL.
  now += 30_000;
  assert.equal(d.isDuplicate(A), true);
  // 60 seconds later — past TTL → no longer a duplicate.
  now += 31_000; // total = 61s after markReported
  assert.equal(d.isDuplicate(A), false);
});

test("IncidentDeduper — distinct severities or metrics are NOT collapsed (different hash)", () => {
  const d = new IncidentDeduper(60_000);
  d.markReported(A);
  // Same service+metric, escalating severity → distinct incident.
  assert.equal(d.isDuplicate(C), false);
  // Same service+severity, different metric → distinct incident.
  assert.equal(d.isDuplicate(B), false);
});

test("IncidentDeduper — cleanExpired drops stale entries, retains in-window ones", () => {
  let now = 1_000_000;
  const d = new IncidentDeduper(60_000, () => now);
  d.markReported(A);
  // Fast-forward past TTL, then mark a fresh one.
  now += 61_000;
  d.markReported(B);
  // Before clean: A is stale but the map still holds it.
  assert.equal(d.size(), 2);
  d.cleanExpired();
  assert.equal(d.size(), 1, "stale A should have been dropped, fresh B retained");
  assert.equal(d.isDuplicate(B), true);
});

test("IncidentDeduper — markReported on a duplicate refreshes the timestamp (slides the window)", () => {
  let now = 1_000_000;
  const d = new IncidentDeduper(60_000, () => now);
  d.markReported(A);
  // 30s later — still a dup; re-mark refreshes the clock.
  now += 30_000;
  d.markReported(A);
  // Another 50s — total 80s since the first mark, but only 50s since
  // the refresh → still inside the 60s window → still a dup.
  now += 50_000;
  assert.equal(d.isDuplicate(A), true);
});

test("IncidentDeduper — production default clock works (sanity smoke against Date.now)", () => {
  const d = new IncidentDeduper(10);
  assert.equal(d.isDuplicate(A), false);
  d.markReported(A);
  assert.equal(d.isDuplicate(A), true);
});
