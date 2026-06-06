import { test } from "node:test";
import assert from "node:assert/strict";

import { parseScimGroupRoleMap, rolesForGroups } from "./group-role-map.js";

test("parseScimGroupRoleMap: empty / undefined → empty map", () => {
  assert.equal(parseScimGroupRoleMap(undefined).size, 0);
  assert.equal(parseScimGroupRoleMap("").size, 0);
});

test("parseScimGroupRoleMap: comma-separated key:role pairs, lowercased keys", () => {
  const m = parseScimGroupRoleMap("Admins:admin,SRE:operator,Readers:viewer");
  assert.equal(m.get("admins"), "admin");
  assert.equal(m.get("sre"), "operator");
  assert.equal(m.get("readers"), "viewer");
});

test("parseScimGroupRoleMap: malformed entries silently dropped", () => {
  const m = parseScimGroupRoleMap("admins:admin,no-colon,:emptyKey,validKey:validRole");
  assert.equal(m.get("admins"), "admin");
  assert.equal(m.get("validkey"), "validRole");
  assert.equal(m.size, 2);
});

test("rolesForGroups: unknown groups dropped (least-privilege)", () => {
  const map = parseScimGroupRoleMap("admins:admin,sre:operator");
  const roles = rolesForGroups(["admins", "unknown-group"], map);
  assert.deepEqual(roles, ["admin"]);
});

test("rolesForGroups: dedupes roles", () => {
  const map = parseScimGroupRoleMap("admins:admin,sysadmins:admin");
  const roles = rolesForGroups(["admins", "sysadmins"], map);
  assert.deepEqual(roles, ["admin"]);
});

test("rolesForGroups: case-insensitive group lookup", () => {
  const map = parseScimGroupRoleMap("Admins:admin");
  assert.deepEqual(rolesForGroups(["ADMINS"], map), ["admin"]);
});
