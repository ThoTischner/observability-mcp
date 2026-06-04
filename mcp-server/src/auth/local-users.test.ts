import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  hashPassword,
  verifyPassword,
  readUsersFile,
  authenticate,
} from "./local-users.js";

// Use a smaller N so the test suite stays under a second even on slow CI runners.
const fastOpts = { N: 1 << 10, r: 8, p: 1 };

test("hashPassword + verifyPassword — accepts correct password", () => {
  const hash = hashPassword("hunter2", fastOpts);
  assert.match(hash, /^scrypt\$1024\$8\$1\$/);
  assert.equal(verifyPassword("hunter2", hash), true);
});

test("verifyPassword — rejects wrong password", () => {
  const hash = hashPassword("hunter2", fastOpts);
  assert.equal(verifyPassword("hunter3", hash), false);
});

test("verifyPassword — rejects malformed hash", () => {
  assert.equal(verifyPassword("anything", ""), false);
  assert.equal(verifyPassword("anything", "plain-text"), false);
  assert.equal(verifyPassword("anything", "argon2$x$y$z"), false);
  assert.equal(verifyPassword("anything", "scrypt$$$$$" /* empty fields */), false);
  assert.equal(verifyPassword("anything", "scrypt$1024$8$1$AAAA$"), false);
});

test("verifyPassword — rejects absurd scrypt cost params (DoS guard)", () => {
  // Far above our MAX_SCRYPT_N / R / P caps. Should fail fast (no hash work).
  assert.equal(verifyPassword("x", "scrypt$1073741824$8$1$AAAA$AAAA"), false);  // N too big
  assert.equal(verifyPassword("x", "scrypt$32768$1024$1$AAAA$AAAA"), false);    // r too big
  assert.equal(verifyPassword("x", "scrypt$32768$8$1024$AAAA$AAAA"), false);    // p too big
});

test("readUsersFile — returns null when the file is missing or malformed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omcp-users-"));
  try {
    assert.equal(await readUsersFile(join(dir, "nope.json")), null);

    const bad = join(dir, "bad.json");
    await writeFile(bad, "not json", "utf8");
    assert.equal(await readUsersFile(bad), null);

    const wrongShape = join(dir, "wrong.json");
    await writeFile(wrongShape, JSON.stringify({ users: "string-not-array" }), "utf8");
    assert.equal(await readUsersFile(wrongShape), null);

    const missingFields = join(dir, "missing.json");
    await writeFile(
      missingFields,
      JSON.stringify({ users: [{ username: "alice" }] }),
      "utf8",
    );
    assert.equal(await readUsersFile(missingFields), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("authenticate — returns user on correct credentials", () => {
  const store = {
    users: [
      {
        username: "alice",
        name: "Alice",
        roles: ["operator"],
        passwordHash: hashPassword("hunter2", fastOpts),
      },
    ],
  };
  const u = authenticate("alice", "hunter2", store);
  assert.ok(u);
  assert.equal(u.username, "alice");
  assert.deepEqual(u.roles, ["operator"]);
});

test("authenticate — returns null for unknown user", () => {
  const store = { users: [] };
  assert.equal(authenticate("nobody", "x", store), null);
});

test("authenticate — returns null for wrong password", () => {
  const store = {
    users: [
      {
        username: "alice",
        name: "Alice",
        passwordHash: hashPassword("hunter2", fastOpts),
      },
    ],
  };
  assert.equal(authenticate("alice", "wrong", store), null);
});

import { writeUsersFile } from "./local-users.js";

test("writeUsersFile — atomic round-trip preserves shape", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "omcp-users-"));
  try {
    const path = join(dir, "users.json");
    const file = {
      users: [
        { username: "alice", name: "Alice", roles: ["operator", "viewer"], tenant: "acme", passwordHash: "scrypt$dummy" },
        { username: "bob", name: "Bob", passwordHash: "scrypt$dummy2" },
      ],
    };
    await writeUsersFile(path, file);
    const back = await readUsersFile(path);
    assert.ok(back);
    assert.equal(back.users.length, 2);
    assert.deepEqual(back.users[0].roles, ["operator", "viewer"]);
    assert.equal(back.users[0].tenant, "acme");
    assert.equal(back.users[1].passwordHash, "scrypt$dummy2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeUsersFile — no .tmp leftover after success (atomic rename)", async () => {
  const { mkdtemp, rm, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "omcp-users-tmp-"));
  try {
    const path = join(dir, "users.json");
    await writeUsersFile(path, { users: [{ username: "u", name: "U", passwordHash: "scrypt$x" }] });
    const entries = await readdir(dir);
    assert.deepEqual(entries.sort(), ["users.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
