import { test } from "node:test";
import assert from "node:assert/strict";

import { parseArgs, pickFreePort, composeOverride } from "./lib.js";

test("parseArgs: command, sub, positionals", () => {
  const p = parseArgs(["demo", "up", "extra"]);
  assert.equal(p.command, "demo");
  assert.equal(p.sub, "up");
  assert.deepEqual(p.positionals, ["extra"]);
});

test("parseArgs: --flag=val, --flag val, boolean, -f val", () => {
  const p = parseArgs(["plugin", "install", "loki", "--from=/m", "--ver", "1.2.0", "--json", "-f", "x"]);
  assert.equal(p.command, "plugin");
  assert.equal(p.sub, "install");
  assert.deepEqual(p.positionals, ["loki"]);
  assert.equal(p.flags.from, "/m");
  assert.equal(p.flags.ver, "1.2.0");
  assert.equal(p.flags.json, true);
  assert.equal(p.flags.f, "x");
});

test("parseArgs: empty argv", () => {
  const p = parseArgs([]);
  assert.equal(p.command, "");
  assert.equal(p.sub, undefined);
});

test("pickFreePort returns desired when free", () => {
  assert.equal(pickFreePort(3000, () => false), 3000);
});

test("pickFreePort skips used ports", () => {
  const used = new Set([3000, 3001, 3002]);
  assert.equal(pickFreePort(3000, (p) => used.has(p)), 3003);
});

test("pickFreePort throws when span exhausted", () => {
  assert.throws(() => pickFreePort(3000, () => true, 5), /no free port/);
});

test("composeOverride emits !override port mappings", () => {
  const y = composeOverride([
    { service: "mcp-server", host: 3001, container: 3000 },
    { service: "loki", host: 3101, container: 3100 },
  ]);
  assert.match(y, /^services:\n/);
  assert.match(y, /  mcp-server:\n    ports: !override\n      - "3001:3000"/);
  assert.match(y, /  loki:\n    ports: !override\n      - "3101:3100"/);
});
