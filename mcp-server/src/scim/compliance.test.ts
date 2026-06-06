// SCIM 2.0 (RFC 7643 / 7644) compliance harness.
//
// Run against a running gateway with SCIM enabled by setting:
//   OMCP_SCIM_COMPLIANCE_URL  — the SCIM base, e.g.
//                               http://localhost:3000/scim/v2
//   OMCP_SCIM_COMPLIANCE_TOKEN — the bearer matching OMCP_SCIM_TOKEN
//
// When the URL is unset every test skips — so the file lives happily
// in a plain `find src -name "*.test.ts"` unit run without needing a
// server. The `make scim-compliance` target boots the demo with SCIM
// configured, waits for /healthz, then runs this file.
//
//   OMCP_SCIM_COMPLIANCE_URL=http://localhost:3000/scim/v2 \
//   OMCP_SCIM_COMPLIANCE_TOKEN=secret \
//   npx tsx --test src/scim/compliance.test.ts
//
// The suite is self-contained: it creates resources, exercises them,
// and deletes them, leaving the store as it found it.

import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.OMCP_SCIM_COMPLIANCE_URL?.replace(/\/+$/, "");
const TOKEN = process.env.OMCP_SCIM_COMPLIANCE_TOKEN || "";
const skip = !BASE;
const opts = skip ? { skip: "OMCP_SCIM_COMPLIANCE_URL not set" } : {};

const SCHEMA_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCHEMA_GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const SCHEMA_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const SCHEMA_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const SCHEMA_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";

interface ScimResp { status: number; json: Record<string, unknown>; headers: Record<string, string>; }

async function scim(method: string, path: string, body?: unknown, withAuth = true): Promise<ScimResp> {
  if (!BASE) throw new Error("OMCP_SCIM_COMPLIANCE_URL not set");
  const headers: Record<string, string> = { "content-type": "application/scim+json" };
  if (withAuth) headers["authorization"] = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const h: Record<string, string> = {};
  res.headers.forEach((v, k) => { h[k] = v; });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  if (text.trim().startsWith("{")) json = JSON.parse(text) as Record<string, unknown>;
  return { status: res.status, json, headers: h };
}

// Resources created during the run, deleted in the final test.
const created: { users: string[]; groups: string[] } = { users: [], groups: [] };
function uniq(p: string): string { return `${p}-${Math.floor(performance.now() * 1000)}-${created.users.length + created.groups.length}`; }

// --- Discovery (RFC 7643 §5) -----------------------------------------

test("ServiceProviderConfig advertises the spec schema + patch support", opts, async () => {
  const r = await scim("GET", "/ServiceProviderConfig");
  assert.equal(r.status, 200);
  assert.ok((r.json.schemas as string[]).includes("urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"));
  assert.ok(r.json.patch, "patch capability block present");
});

test("ResourceTypes lists User + Group endpoints", opts, async () => {
  const r = await scim("GET", "/ResourceTypes");
  assert.equal(r.status, 200);
  const txt = JSON.stringify(r.json);
  assert.ok(txt.includes("/Users") && txt.includes("/Groups"));
});

test("Schemas endpoint returns the core schema definitions", opts, async () => {
  const r = await scim("GET", "/Schemas");
  assert.equal(r.status, 200);
  const txt = JSON.stringify(r.json);
  assert.ok(txt.includes(SCHEMA_USER) && txt.includes(SCHEMA_GROUP));
});

// --- Auth (RFC 7644 §2) ----------------------------------------------

test("requests without a bearer token are rejected 401", opts, async () => {
  const r = await scim("GET", "/Users", undefined, false);
  assert.equal(r.status, 401);
  assert.ok((r.json.schemas as string[] | undefined)?.includes(SCHEMA_ERROR));
});

// --- User lifecycle (RFC 7644 §3.3–3.6) ------------------------------

let userId = "";
const userName = uniq("compliance-user") + "@example.com";

test("POST /Users creates a user → 201 with id + meta", opts, async () => {
  const r = await scim("POST", "/Users", {
    schemas: [SCHEMA_USER],
    userName,
    name: { givenName: "Comp", familyName: "Liance" },
    emails: [{ value: userName, primary: true }],
    active: true,
  });
  assert.equal(r.status, 201);
  assert.equal(typeof r.json.id, "string");
  assert.equal(r.json.userName, userName);
  const meta = r.json.meta as Record<string, unknown>;
  assert.equal(meta.resourceType, "User");
  assert.ok(meta.created && meta.lastModified);
  userId = r.json.id as string;
  created.users.push(userId);
});

test("duplicate userName is rejected 409 uniqueness", opts, async () => {
  const r = await scim("POST", "/Users", { schemas: [SCHEMA_USER], userName });
  assert.equal(r.status, 409);
  assert.equal((r.json as { scimType?: string }).scimType, "uniqueness");
});

test("GET /Users/:id returns the created user", opts, async () => {
  const r = await scim("GET", `/Users/${userId}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.id, userId);
  assert.equal(r.json.userName, userName);
});

test("GET /Users returns a ListResponse envelope", opts, async () => {
  const r = await scim("GET", "/Users");
  assert.equal(r.status, 200);
  assert.ok((r.json.schemas as string[]).includes(SCHEMA_LIST));
  assert.equal(typeof r.json.totalResults, "number");
  assert.ok(Array.isArray(r.json.Resources));
});

test("PATCH /Users/:id replace toggles active", opts, async () => {
  const r = await scim("PATCH", `/Users/${userId}`, {
    schemas: [SCHEMA_PATCH],
    Operations: [{ op: "replace", path: "active", value: false }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.active, false);
});

test("unknown user id → 404 with SCIM error schema", opts, async () => {
  const r = await scim("GET", "/Users/does-not-exist");
  assert.equal(r.status, 404);
  assert.ok((r.json.schemas as string[]).includes(SCHEMA_ERROR));
});

// --- Group lifecycle + membership PATCH (Q14) ------------------------

let groupId = "";

test("POST /Groups creates a group", opts, async () => {
  const r = await scim("POST", "/Groups", { schemas: [SCHEMA_GROUP], displayName: uniq("compliance-grp") });
  assert.equal(r.status, 201);
  groupId = r.json.id as string;
  created.groups.push(groupId);
  assert.equal((r.json.meta as Record<string, unknown>).resourceType, "Group");
});

test("PATCH /Groups/:id add member → membership reflected", opts, async () => {
  const r = await scim("PATCH", `/Groups/${groupId}`, {
    schemas: [SCHEMA_PATCH],
    Operations: [{ op: "add", path: "members", value: [{ value: userId, display: userName }] }],
  });
  assert.equal(r.status, 200);
  const members = (r.json.members as Array<{ value: string }>) || [];
  assert.ok(members.some((m) => m.value === userId), "added member present");
});

test("PATCH /Groups/:id remove member by filter → membership cleared", opts, async () => {
  const r = await scim("PATCH", `/Groups/${groupId}`, {
    schemas: [SCHEMA_PATCH],
    Operations: [{ op: "remove", path: `members[value eq "${userId}"]` }],
  });
  assert.equal(r.status, 200);
  const members = (r.json.members as Array<{ value: string }>) || [];
  assert.ok(!members.some((m) => m.value === userId), "removed member gone");
});

// --- Cleanup (DELETE → 204, then 404) --------------------------------

test("DELETE created resources → 204 and subsequent GET → 404", opts, async () => {
  for (const id of created.groups) {
    const del = await scim("DELETE", `/Groups/${id}`);
    assert.ok(del.status === 204 || del.status === 200, `group delete status ${del.status}`);
    const get = await scim("GET", `/Groups/${id}`);
    assert.equal(get.status, 404);
  }
  for (const id of created.users) {
    const del = await scim("DELETE", `/Users/${id}`);
    assert.ok(del.status === 204 || del.status === 200, `user delete status ${del.status}`);
    const get = await scim("GET", `/Users/${id}`);
    assert.equal(get.status, 404);
  }
});
