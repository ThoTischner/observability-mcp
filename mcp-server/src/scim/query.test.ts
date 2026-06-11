import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseScimFilter, applyScimList } from "./query.js";

describe("parseScimFilter", () => {
  it("returns null for absent/empty filter", () => {
    assert.equal(parseScimFilter(undefined), null);
    assert.equal(parseScimFilter("   "), null);
  });
  it("parses string eq (case-insensitive op)", () => {
    assert.deepEqual(parseScimFilter('userName eq "alice@x.com"'), { attr: "userName", op: "eq", value: "alice@x.com" });
    assert.deepEqual(parseScimFilter('displayName EQ "Admins"'), { attr: "displayName", op: "eq", value: "Admins" });
  });
  it("parses boolean eq for active", () => {
    assert.deepEqual(parseScimFilter("active eq true"), { attr: "active", op: "eq", value: true });
    assert.deepEqual(parseScimFilter("active eq false"), { attr: "active", op: "eq", value: false });
  });
  it("throws scimUnsupported for non-eq operators / malformed", () => {
    for (const f of ['userName co "a"', 'userName sw "a"', 'userName pr', 'garbage']) {
      assert.throws(() => parseScimFilter(f), (e: any) => e.scimUnsupported === true, `expected unsupported for: ${f}`);
    }
  });
});

describe("applyScimList", () => {
  const users = [
    { id: "1", userName: "alice@x.com", active: true },
    { id: "2", userName: "bob@x.com", active: false },
    { id: "3", userName: "carol@x.com", active: true },
  ];

  it("no filter, no pagination → all rows, correct envelope", () => {
    const r = applyScimList(users, {});
    assert.equal(r.totalResults, 3);
    assert.equal(r.startIndex, 1);
    assert.equal(r.itemsPerPage, 3);
    assert.equal(r.resources.length, 3);
  });

  it("eq filter matches case-insensitively on the value", () => {
    const r = applyScimList(users, { filter: 'userName eq "ALICE@X.COM"' });
    assert.equal(r.totalResults, 1);
    assert.equal(r.resources[0].id, "1");
  });

  it("eq filter with no match → empty, totalResults 0 (not all rows)", () => {
    const r = applyScimList(users, { filter: 'userName eq "nobody@x.com"' });
    assert.equal(r.totalResults, 0);
    assert.equal(r.resources.length, 0);
  });

  it("boolean eq filters on active", () => {
    assert.equal(applyScimList(users, { filter: "active eq true" }).totalResults, 2);
    assert.equal(applyScimList(users, { filter: "active eq false" }).totalResults, 1);
  });

  it("pagination: startIndex + count slice; totalResults is the pre-page count", () => {
    const r = applyScimList(users, { startIndex: "2", count: "1" });
    assert.equal(r.totalResults, 3);
    assert.equal(r.startIndex, 2);
    assert.equal(r.itemsPerPage, 1);
    assert.equal(r.resources[0].id, "2");
  });

  it("count=0 returns an empty page but the real totalResults", () => {
    const r = applyScimList(users, { count: "0" });
    assert.equal(r.totalResults, 3);
    assert.equal(r.resources.length, 0);
  });

  it("filter + pagination compose", () => {
    const r = applyScimList(users, { filter: "active eq true", startIndex: "2", count: "5" });
    assert.equal(r.totalResults, 2); // alice + carol
    assert.equal(r.resources.length, 1); // from index 2 of the 2 matches
    assert.equal(r.resources[0].id, "3");
  });

  it("propagates the unsupported-filter error for the route to 400", () => {
    assert.throws(() => applyScimList(users, { filter: 'userName co "x"' }), (e: any) => e.scimUnsupported === true);
  });
});
