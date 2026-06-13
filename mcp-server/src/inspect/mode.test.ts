import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ModeController, parseMode, bootMode } from "./mode.js";

describe("parseMode / bootMode", () => {
  it("accepts canonical modes + friendly aliases", () => {
    assert.equal(parseMode("off"), "off");
    assert.equal(parseMode("observe"), "observe");
    assert.equal(parseMode("dryrun"), "dryrun");
    assert.equal(parseMode("enforce"), "enforce");
    assert.equal(parseMode("DRY-RUN"), "dryrun");
    assert.equal(parseMode("complain"), "dryrun");
    assert.equal(parseMode("on"), "observe");
  });
  it("rejects junk", () => {
    assert.equal(parseMode("nope"), null);
    assert.equal(parseMode(123), null);
    assert.equal(parseMode(undefined), null);
  });
  it("bootMode defaults to observe", () => {
    assert.equal(bootMode(undefined), "observe");
    assert.equal(bootMode("enforce"), "enforce");
    assert.equal(bootMode("garbage"), "observe");
  });
});

describe("ModeController", () => {
  it("exposes recording/evaluating/blocking per mode", () => {
    const off = new ModeController("off");
    assert.equal(off.recording, false);
    assert.equal(off.evaluating, false);
    assert.equal(off.blocking, false);

    const observe = new ModeController("observe");
    assert.equal(observe.recording, true);
    assert.equal(observe.evaluating, false);
    assert.equal(observe.blocking, false);

    const dry = new ModeController("dryrun");
    assert.equal(dry.recording, true);
    assert.equal(dry.evaluating, true);
    assert.equal(dry.blocking, false);

    const enf = new ModeController("enforce");
    assert.equal(enf.recording, true);
    assert.equal(enf.evaluating, true);
    assert.equal(enf.blocking, true);
  });

  it("set() validates and fires onChange", () => {
    const seen: string[] = [];
    const m = new ModeController("observe", (x) => seen.push(x));
    assert.equal(m.set("enforce"), "enforce");
    assert.equal(m.get(), "enforce");
    assert.deepEqual(seen, ["enforce"]);
    assert.throws(() => m.set("bogus"), /invalid inspect mode/);
    assert.equal(m.get(), "enforce"); // unchanged after a bad set
  });
});
