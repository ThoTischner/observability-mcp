import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LokiConnector } from "./loki.js";

const proto = LokiConnector.prototype as any;

describe("LokiConnector", () => {
  describe("parseLine", () => {
    it("parses valid JSON", () => {
      const result = proto.parseLine('{"level":"error","msg":"timeout"}');
      assert.equal(result.level, "error");
      assert.equal(result.msg, "timeout");
    });

    it("returns msg wrapper for invalid JSON", () => {
      const result = proto.parseLine("plain text log line");
      assert.equal(result.msg, "plain text log line");
    });

    it("handles empty string", () => {
      const result = proto.parseLine("");
      assert.equal(result.msg, "");
    });

    it("parses complex JSON", () => {
      const result = proto.parseLine('{"level":"info","msg":"ok","nested":{"key":"val"}}');
      assert.equal(result.level, "info");
      assert.deepEqual(result.nested, { key: "val" });
    });
  });

  describe("extractTopPatterns", () => {
    it("returns empty for no entries", () => {
      assert.deepEqual(proto.extractTopPatterns([]), []);
    });

    it("counts duplicate patterns", () => {
      const entries = [
        { message: "connection timeout" },
        { message: "connection timeout" },
        { message: "connection timeout" },
        { message: "null pointer" },
      ];
      const patterns = proto.extractTopPatterns(entries);
      assert.equal(patterns.length, 2);
      assert.ok(patterns[0].includes("connection timeout"));
      assert.ok(patterns[0].includes("3x"));
      assert.ok(patterns[1].includes("null pointer"));
      assert.ok(patterns[1].includes("1x"));
    });

    it("limits to top 5 patterns", () => {
      const entries = [];
      for (let i = 0; i < 10; i++) {
        entries.push({ message: `error type ${i}` });
      }
      const patterns = proto.extractTopPatterns(entries);
      assert.equal(patterns.length, 5);
    });

    it("sorts by count descending", () => {
      const entries = [
        { message: "rare error" },
        { message: "common error" },
        { message: "common error" },
        { message: "common error" },
      ];
      const patterns = proto.extractTopPatterns(entries);
      assert.ok(patterns[0].includes("common error"));
      assert.ok(patterns[0].includes("3x"));
    });

    it("truncates long messages to 100 chars for pattern key", () => {
      const longMsg = "x".repeat(200);
      const entries = [{ message: longMsg }, { message: longMsg }];
      const patterns = proto.extractTopPatterns(entries);
      assert.equal(patterns.length, 1);
      assert.ok(patterns[0].includes("2x"));
    });
  });

  describe("parseTimeRange", () => {
    it("parses minutes", () => {
      const { start, end } = proto.parseTimeRange("10m");
      assert.ok(end - start >= 599 && end - start <= 601);
    });

    it("parses hours", () => {
      const { start, end } = proto.parseTimeRange("2h");
      assert.ok(end - start >= 7199 && end - start <= 7201);
    });

    it("parses days", () => {
      const { start, end } = proto.parseTimeRange("1d");
      assert.ok(end - start >= 86399 && end - start <= 86401);
    });

    it("throws on invalid duration", () => {
      assert.throws(() => proto.parseTimeRange("invalid"));
      assert.throws(() => proto.parseTimeRange("5s"));
    });
  });

  describe("escapeLogQLValue", () => {
    it("returns value unchanged when no escaping needed", () => {
      assert.equal(proto.escapeLogQLValue("api-gateway"), "api-gateway");
    });

    it("escapes backslashes", () => {
      assert.equal(proto.escapeLogQLValue("path\\to\\file"), "path\\\\to\\\\file");
    });

    it("escapes double quotes", () => {
      assert.equal(proto.escapeLogQLValue('say "hello"'), 'say \\"hello\\"');
    });

    it("escapes both", () => {
      assert.equal(proto.escapeLogQLValue('a\\b"c'), 'a\\\\b\\"c');
    });
  });

  describe("escapeLogQLRegex", () => {
    it("returns value unchanged when no backticks", () => {
      assert.equal(proto.escapeLogQLRegex("error.*timeout"), "error.*timeout");
    });

    it("escapes backticks", () => {
      assert.equal(proto.escapeLogQLRegex("error`test`"), "error\\`test\\`");
    });
  });
});
