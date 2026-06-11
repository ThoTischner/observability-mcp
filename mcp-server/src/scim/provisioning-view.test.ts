import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectProvisioning } from "./provisioning-view.js";
import type { IScimStore } from "./store.js";
import type { ScimUser, ScimGroup } from "./types.js";

const meta = { resourceType: "User" as const, created: "", lastModified: "", location: "" };

function storeWith(users: ScimUser[], groups: ScimGroup[]): IScimStore {
  // Only listUsers/listGroups are exercised by the projection.
  return { listUsers: () => users, listGroups: () => groups } as unknown as IScimStore;
}

describe("projectProvisioning", () => {
  it("returns configured:false + a note when the store is null (SCIM not enabled)", () => {
    const v = projectProvisioning(null);
    assert.equal(v.configured, false);
    assert.deepEqual(v.users, []);
    assert.deepEqual(v.groups, []);
    assert.match(v.note ?? "", /OMCP_SCIM_TOKEN/);
  });

  it("projects users to a compact, secret-free shape", () => {
    const store = storeWith(
      [{
        schemas: [], id: "u1", userName: "alice@x.com", active: true,
        displayName: "Alice", groups: [{ value: "g1", display: "Admins" }],
        externalId: "ext-1", meta: { ...meta },
      }],
      [],
    );
    const v = projectProvisioning(store);
    assert.equal(v.configured, true);
    assert.deepEqual(v.users, [{
      userName: "alice@x.com", displayName: "Alice", active: true,
      groups: ["Admins"], externalId: "ext-1",
    }]);
    // No secret/raw fields leaked.
    assert.ok(!("schemas" in v.users[0]) && !("meta" in v.users[0]));
  });

  it("active defaults to true when unset; displayName falls back to name.formatted", () => {
    const store = storeWith(
      [{ schemas: [], id: "u2", userName: "bob", name: { formatted: "Bob B" }, meta: { ...meta } }],
      [],
    );
    const v = projectProvisioning(store);
    assert.equal(v.users[0].active, true);
    assert.equal(v.users[0].displayName, "Bob B");
    assert.deepEqual(v.users[0].groups, []);
  });

  it("active:false is preserved", () => {
    const store = storeWith(
      [{ schemas: [], id: "u3", userName: "carol", active: false, meta: { ...meta } }],
      [],
    );
    assert.equal(projectProvisioning(store).users[0].active, false);
  });

  it("projects groups with a member count, not the member list", () => {
    const store = storeWith(
      [],
      [{
        schemas: [], id: "g1", displayName: "Admins",
        members: [{ value: "u1" }, { value: "u2" }], externalId: "grp-1", meta: { ...meta },
      }],
    );
    const v = projectProvisioning(store);
    assert.deepEqual(v.groups, [{ displayName: "Admins", members: 2, externalId: "grp-1" }]);
  });
});
