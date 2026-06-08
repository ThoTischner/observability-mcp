import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RevocationStore } from "./revocation.js";

function tmpFile(name = "revocations.jsonl"): string {
  const dir = mkdtempSync(join(tmpdir(), "omcp-revoke-"));
  return join(dir, name);
}

test("memory store revokes a single session by sid", async () => {
  const store = await RevocationStore.create();
  assert.equal(store.persistent, false);
  assert.equal(store.isRevoked({ sub: "alice", iat: 1000, sid: "s1" }), false);

  await store.revokeSession("s1");
  assert.equal(store.isRevoked({ sub: "alice", iat: 1000, sid: "s1" }), true);
  // A different session of the same subject is untouched.
  assert.equal(store.isRevoked({ sub: "alice", iat: 1000, sid: "s2" }), false);
});

test("session without a sid is never caught by a session-kind revocation", async () => {
  const store = await RevocationStore.create();
  await store.revokeSession("s1");
  assert.equal(store.isRevoked({ sub: "alice", iat: 1000 }), false);
});

test("subject revocation catches sessions issued at or before the cutoff", async () => {
  let clock = 5000;
  const store = await RevocationStore.create({ now: () => clock });
  await store.revokeSubject("bob");

  // Issued before the cutoff → revoked.
  assert.equal(store.isRevoked({ sub: "bob", iat: 4999, sid: "old" }), true);
  // Issued in the same second → revoked (intent: kill what exists now).
  assert.equal(store.isRevoked({ sub: "bob", iat: 5000, sid: "same" }), true);
  // Issued after the cutoff (fresh login) → valid again.
  assert.equal(store.isRevoked({ sub: "bob", iat: 5001, sid: "new" }), false);
  // A different subject is unaffected.
  assert.equal(store.isRevoked({ sub: "carol", iat: 1, sid: "x" }), false);
});

test("re-revoking a subject only widens the cutoff window", async () => {
  let clock = 100;
  const store = await RevocationStore.create({ now: () => clock });
  await store.revokeSubject("dave"); // cutoff 100
  clock = 200;
  await store.revokeSubject("dave"); // cutoff 200
  assert.equal(store.isRevoked({ sub: "dave", iat: 150, sid: "mid" }), true);
  assert.equal(store.isRevoked({ sub: "dave", iat: 201, sid: "after" }), false);
});

test("entries persist to disk and reload into a fresh store", async () => {
  const path = tmpFile();
  const store = await RevocationStore.create({ path, now: () => 7000 });
  await store.revokeSession("sid-a", { reason: "stolen laptop", by: "admin" });
  await store.revokeSubject("eve", { reason: "offboarded" });
  assert.equal(store.size, 2);

  const reloaded = await RevocationStore.create({ path });
  assert.equal(reloaded.size, 2);
  assert.equal(reloaded.isRevoked({ sub: "x", iat: 1, sid: "sid-a" }), true);
  assert.equal(reloaded.isRevoked({ sub: "eve", iat: 6999, sid: "z" }), true);
  assert.equal(reloaded.isRevoked({ sub: "eve", iat: 7001, sid: "z" }), false);
});

test("persisted file is JSONL and carries the metadata", async () => {
  const path = tmpFile();
  const store = await RevocationStore.create({ path, now: () => 42 });
  await store.revokeSession("sid-meta", { reason: "test", by: "root" });

  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.deepEqual(entry, {
    kind: "session",
    value: "sid-meta",
    revokedAt: 42,
    reason: "test",
    by: "root",
  });
});

test("malformed and partial lines are skipped on load", async () => {
  const path = tmpFile();
  writeFileSync(
    path,
    [
      JSON.stringify({ kind: "session", value: "good", revokedAt: 1 }),
      "not json at all",
      JSON.stringify({ kind: "bogus", value: "x", revokedAt: 1 }), // bad kind
      JSON.stringify({ kind: "subject", value: "", revokedAt: 1 }), // empty value
      JSON.stringify({ kind: "subject", value: "u", revokedAt: "nope" }), // bad ts
      "", // blank
      JSON.stringify({ kind: "subject", value: "frank", revokedAt: 500 }),
    ].join("\n"),
  );
  const store = await RevocationStore.create({ path });
  // Only the two well-formed entries survived.
  assert.equal(store.size, 2);
  assert.equal(store.isRevoked({ sub: "x", iat: 1, sid: "good" }), true);
  assert.equal(store.isRevoked({ sub: "frank", iat: 400, sid: "y" }), true);
});

test("missing file is treated as an empty blocklist", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "omcp-revoke-")), "does-not-exist.jsonl");
  const store = await RevocationStore.create({ path });
  assert.equal(store.size, 0);
  assert.equal(store.isRevoked({ sub: "a", iat: 1, sid: "s" }), false);
  // First write creates the file.
  await store.revokeSession("s");
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 1);
});

test("file under a non-existent directory is created on first write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omcp-revoke-"));
  const path = join(dir, "nested", "deep", "revocations.jsonl");
  const store = await RevocationStore.create({ path });
  await store.revokeSession("s");
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 1);
});

test("list() returns a defensive copy in file order", async () => {
  const store = await RevocationStore.create({ now: () => 9 });
  await store.revokeSession("a");
  await store.revokeSubject("b");
  const list = store.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].kind, "session");
  assert.equal(list[1].kind, "subject");
  // Mutating the returned array/objects must not corrupt the store.
  list[0].value = "tampered";
  list.push({ kind: "session", value: "ghost", revokedAt: 0 });
  assert.equal(store.list().length, 2);
  assert.equal(store.list()[0].value, "a");
});

test("concurrent revokes all land on disk without interleaving", async () => {
  const path = tmpFile();
  const store = await RevocationStore.create({ path, now: () => 1 });
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => store.revokeSession(`s${i}`)),
  );
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 20);
  // Every line is independently parseable (no torn writes).
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
});

test("reason/by are omitted from the entry when not supplied", async () => {
  const store = await RevocationStore.create({ now: () => 3 });
  const entry = await store.revokeSession("s");
  assert.deepEqual(entry, { kind: "session", value: "s", revokedAt: 3 });
});
