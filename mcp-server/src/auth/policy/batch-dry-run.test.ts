import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateBatch,
  batchResultToCsv,
  DEFAULT_BATCH_LIMITS,
  type BatchDryRunRequest,
} from "./batch-dry-run.js";
import type { PolicyEngine } from "./engine.js";

class FakeEngine implements PolicyEngine {
  // Allow when the roles array contains "admin", or
  // when ((resource, action) is (sources, read) for any role).
  evaluate(roles: string[] | undefined, resource: never, action: never): { allowed: boolean; reason?: string } {
    if (roles?.includes("admin")) return { allowed: true, reason: "admin role" };
    if (resource === "sources" && action === "read") return { allowed: true, reason: "public read" };
    return { allowed: false, reason: `denied: roles=${(roles ?? []).join(",")} can't ${action} on ${resource}` };
  }
  roles(): string[] {
    return ["admin", "viewer"];
  }
  kind(): string {
    return "fake";
  }
}

const VALID_RES = new Set(["sources", "services", "settings"]);
const VALID_ACT = new Set(["read", "write", "delete"]);

function req(overrides: Partial<BatchDryRunRequest> = {}): BatchDryRunRequest {
  return {
    subjects: [{ key: "alice", roles: ["viewer"] }],
    resources: ["sources"],
    actions: ["read"],
    ...overrides,
  };
}

test("evaluateBatch: empty request → empty matrix + zero totals", async () => {
  const r = await evaluateBatch(new FakeEngine(), { subjects: [], resources: [], actions: [] }, VALID_RES, VALID_ACT);
  assert.deepEqual(r.matrix, {});
  assert.deepEqual(r.totals, { cells: 0, allow: 0, deny: 0 });
  assert.deepEqual(r.dropped, []);
});

test("evaluateBatch: 1×1×1 returns one verdict cell", async () => {
  const r = await evaluateBatch(new FakeEngine(), req(), VALID_RES, VALID_ACT);
  assert.equal(r.matrix.alice.sources.read.allowed, true);
  assert.equal(r.matrix.alice.sources.read.reason, "public read");
  assert.equal(r.totals.cells, 1);
  assert.equal(r.totals.allow, 1);
  assert.equal(r.totals.deny, 0);
});

test("evaluateBatch: full 2×2×2 matrix populated end-to-end", async () => {
  const r = await evaluateBatch(
    new FakeEngine(),
    {
      subjects: [
        { key: "alice", roles: ["viewer"] },
        { key: "bob", roles: ["admin"] },
      ],
      resources: ["sources", "services"],
      actions: ["read", "delete"],
    },
    VALID_RES,
    VALID_ACT,
  );
  assert.equal(r.totals.cells, 8);
  assert.equal(r.matrix.alice.sources.read.allowed, true);   // public read
  assert.equal(r.matrix.alice.services.read.allowed, false); // viewer can't read services
  assert.equal(r.matrix.bob.services.delete.allowed, true);  // admin
});

test("evaluateBatch: unknown resource → dropped + matrix omits it", async () => {
  const r = await evaluateBatch(
    new FakeEngine(),
    req({ resources: ["sources", "totally-bogus"] }),
    VALID_RES,
    VALID_ACT,
  );
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0].kind, "resource");
  assert.equal(r.dropped[0].value, "totally-bogus");
  // Matrix has only the surviving resource
  assert.deepEqual(Object.keys(r.matrix.alice), ["sources"]);
});

test("evaluateBatch: unknown action → dropped", async () => {
  const r = await evaluateBatch(
    new FakeEngine(),
    req({ actions: ["read", "blow-up"] }),
    VALID_RES,
    VALID_ACT,
  );
  assert.equal(r.dropped.some((d) => d.kind === "action" && d.value === "blow-up"), true);
});

test("evaluateBatch: deduplicates repeated inputs", async () => {
  const r = await evaluateBatch(
    new FakeEngine(),
    {
      subjects: [
        { key: "alice", roles: ["viewer"] },
        { key: "alice", roles: ["admin"] }, // dropped because key already seen
      ],
      resources: ["sources", "sources", "services"],
      actions: ["read", "read", "delete"],
    },
    VALID_RES,
    VALID_ACT,
  );
  // alice runs once, with the first-seen roles array (viewer); 1 subject × 2 resources × 2 actions = 4 cells.
  assert.equal(Object.keys(r.matrix).length, 1);
  assert.equal(r.totals.cells, 4);
});

test("evaluateBatch: malformed subject (missing roles) dropped with note", async () => {
  const r = await evaluateBatch(
    new FakeEngine(),
    {
      subjects: [
        { key: "alice", roles: ["viewer"] },
        { key: "broken" } as never, // no roles → drop
      ],
      resources: ["sources"],
      actions: ["read"],
    },
    VALID_RES,
    VALID_ACT,
  );
  assert.equal(Object.keys(r.matrix).length, 1);
  assert.ok(r.dropped.some((d) => d.kind === "subject" && d.value === "broken"));
});

test("evaluateBatch: cap enforcement truncates oversize lists, notes in dropped", async () => {
  const subjects = Array.from({ length: 5 }, (_, i) => ({ key: `s${i}`, roles: ["viewer"] }));
  const resources = Array.from({ length: 3 }, (_, i) => `sources`); // dedup → 1
  const r = await evaluateBatch(
    new FakeEngine(),
    { subjects, resources, actions: ["read"] },
    VALID_RES,
    VALID_ACT,
    { maxSubjects: 2, maxResources: 5, maxActions: 5 },
  );
  // truncated to 2 subjects × 1 resource × 1 action
  assert.equal(r.totals.cells, 2);
  assert.ok(r.dropped.some((d) => d.kind === "cap" && d.value.startsWith("subjects=")));
});

test("evaluateBatch: per-subject tenant is threaded into engine.evaluate", async () => {
  let lastTenant: string | undefined;
  class TenantTracker implements PolicyEngine {
    evaluate(_roles: string[] | undefined, _r: never, _a: never, ctx?: { tenant?: string }): { allowed: boolean } {
      lastTenant = ctx?.tenant;
      return { allowed: true };
    }
    roles(): string[] { return []; }
    kind() { return "tracker"; }
  }
  await evaluateBatch(
    new TenantTracker(),
    {
      subjects: [{ key: "alice", roles: ["viewer"], tenant: "acme" }],
      resources: ["sources"],
      actions: ["read"],
    },
    VALID_RES,
    VALID_ACT,
  );
  assert.equal(lastTenant, "acme");
});

test("batchResultToCsv: produces the documented header + escapes commas and quotes", async () => {
  const r = await evaluateBatch(
    new FakeEngine(),
    {
      subjects: [{ key: 'alice,senior "lead"', roles: ["viewer"] }],
      resources: ["sources"],
      actions: ["read"],
    },
    VALID_RES,
    VALID_ACT,
  );
  const csv = batchResultToCsv(r);
  assert.match(csv.split("\n")[0], /^subject,resource,action,allowed,reason$/);
  // Quoted because of comma + embedded quotes doubled
  assert.match(csv, /"alice,senior ""lead"""/);
});

test("DEFAULT_BATCH_LIMITS matches the documented 100×100×10 cap", () => {
  assert.equal(DEFAULT_BATCH_LIMITS.maxSubjects, 100);
  assert.equal(DEFAULT_BATCH_LIMITS.maxResources, 100);
  assert.equal(DEFAULT_BATCH_LIMITS.maxActions, 10);
});
