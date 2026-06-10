import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LokiConnector,
  logqlLabelFilters,
  levelFromStatus,
  escapeLogQLValue,
  buildAggregateLogQL,
  parseDurationSeconds,
  defaultBucketSeconds,
} from "./loki.js";

const proto = LokiConnector.prototype as any;

function jsonRes(obj: unknown) {
  return { ok: true, status: 200, statusText: "OK", json: async () => obj, text: async () => "" } as Response;
}

describe("Q-LOG1: logqlLabelFilters", () => {
  it("returns empty string for undefined / empty", () => {
    assert.equal(logqlLabelFilters(undefined), "");
    assert.equal(logqlLabelFilters({}), "");
  });
  it("compiles a single filter", () => {
    assert.equal(logqlLabelFilters({ method: "GET" }), ' | method="GET"');
  });
  it("compiles multiple filters, keys sorted for determinism", () => {
    assert.equal(
      logqlLabelFilters({ status: "200", method: "GET", url: "/" }),
      ' | method="GET" | status="200" | url="/"',
    );
  });
  it("escapes double quotes and backslashes in values", () => {
    assert.equal(logqlLabelFilters({ path: 'a"b\\c' }), ' | path="a\\"b\\\\c"');
  });
});

describe("Q-LOG1: levelFromStatus", () => {
  it("maps 5xx → error", () => {
    assert.equal(levelFromStatus(500), "error");
    assert.equal(levelFromStatus("503"), "error");
    assert.equal(levelFromStatus(599), "error");
  });
  it("maps 4xx → warn", () => {
    assert.equal(levelFromStatus(404), "warn");
    assert.equal(levelFromStatus("400"), "warn");
  });
  it("returns undefined for 2xx/3xx and non-numeric", () => {
    assert.equal(levelFromStatus(200), undefined);
    assert.equal(levelFromStatus(301), undefined);
    assert.equal(levelFromStatus("abc"), undefined);
    assert.equal(levelFromStatus(undefined), undefined);
  });
});

describe("Q-LOG1: escapeLogQLValue", () => {
  it("escapes backslash then quote", () => {
    assert.equal(escapeLogQLValue('he said "hi"\\'), 'he said \\"hi\\"\\\\');
  });
  it("escapes control chars (newline/return/tab) into LogQL escape sequences", () => {
    assert.equal(escapeLogQLValue("a\nb\rc\td"), "a\\nb\\rc\\td");
  });
});

describe("Q-LOG1: queryLogs LogQL assembly", () => {
  async function captureQuery(params: any): Promise<string> {
    const conn = new LokiConnector();
    await conn.connect({ name: "loki", type: "loki", url: "http://loki:3100", enabled: true } as any);
    let captured = "";
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      if (u.includes("/label/") && u.includes("/values")) return jsonRes({ data: ["payment"] });
      if (u.includes("/query_range")) {
        captured = decodeURIComponent((u.match(/query=([^&]+)/) || [])[1] || "");
        return jsonRes({ data: { result: [] } });
      }
      return jsonRes({ data: [] });
    }) as any;
    try {
      await conn.queryLogs({ service: "payment", duration: "5m", ...params });
    } finally {
      globalThis.fetch = orig;
    }
    return captured;
  }

  it("AND's label filters after | json, with level and line filter", async () => {
    const q = await captureQuery({ level: "error", labels: { method: "GET", status: "200" }, query: "timeout" });
    assert.equal(q, '{service_name="payment"} | json | level="error" | method="GET" | status="200" |~ `timeout`');
  });

  it("works with labels only (no level/query)", async () => {
    const q = await captureQuery({ labels: { environment: "prod" } });
    assert.equal(q, '{service_name="payment"} | json | environment="prod"');
  });

  it("plain query (no labels) is unchanged from prior behaviour", async () => {
    const q = await captureQuery({});
    assert.equal(q, '{service_name="payment"} | json');
  });

  it("R4: rawQuery is sent verbatim, bypassing the curated selector", async () => {
    const q = await captureQuery({
      rawQuery: '{app="x", env="prod"} | json | status>=`500`',
    });
    assert.equal(q, '{app="x", env="prod"} | json | status>=`500`');
  });

  it("R4: rawQuery ignores service/labels/level/query", async () => {
    const q = await captureQuery({
      rawQuery: '{job="raw"}',
      labels: { method: "GET" },
      level: "error",
      query: "ignored",
    });
    assert.equal(q, '{job="raw"}');
  });
});

describe("Q-LOG2: parseDurationSeconds / defaultBucketSeconds", () => {
  it("parses m/h/d", () => {
    assert.equal(parseDurationSeconds("5m"), 300);
    assert.equal(parseDurationSeconds("2h"), 7200);
    assert.equal(parseDurationSeconds("1d"), 86400);
    assert.equal(parseDurationSeconds("bad"), null);
  });
  it("buckets to ~60 points, floored at 60s", () => {
    assert.equal(defaultBucketSeconds(3600), 60);      // 1h → 60s
    assert.equal(defaultBucketSeconds(86400), 1440);   // 24h → 1440s
    assert.equal(defaultBucketSeconds(60), 60);        // tiny window floors at 60s
  });
});

describe("Q-LOG2: buildAggregateLogQL", () => {
  const PIPE = '{service_name="app"} | json | method="GET"';
  it("count_over_time with by → sum by + range mode + step", () => {
    const r = buildAggregateLogQL(PIPE, { op: "count_over_time", by: ["url"], step: "15m" }, "1h");
    assert.equal(r.mode, "range");
    assert.equal(r.step, "900s");
    assert.equal(r.logql, `sum by (url) (count_over_time(${PIPE} [900s]))`);
  });
  it("count_over_time without by → sum-wrapped (single series), default step (#452)", () => {
    // Regression for issue #452: a bare count_over_time over a `| json` stream
    // keeps every extracted label as its own series. With no `by` we must
    // collapse to one bucketed total via sum(...).
    const r = buildAggregateLogQL(PIPE, { op: "count_over_time" }, "1h");
    assert.equal(r.mode, "range");
    assert.equal(r.step, "60s");
    assert.equal(r.logql, `sum (count_over_time(${PIPE} [60s]))`);
  });
  it("sum → instant total per group over the whole window", () => {
    const r = buildAggregateLogQL(PIPE, { op: "sum", by: ["status"] }, "1h");
    assert.equal(r.mode, "instant");
    assert.equal(r.logql, `sum by (status) (count_over_time(${PIPE} [3600s]))`);
  });
  it("topk → instant topk(k, sum by) with default k=10", () => {
    const r = buildAggregateLogQL(PIPE, { op: "topk", by: ["url"] }, "1h");
    assert.equal(r.mode, "instant");
    assert.equal(r.logql, `topk(10, sum by (url) (count_over_time(${PIPE} [3600s])))`);
  });
  it("topk honours explicit k", () => {
    const r = buildAggregateLogQL(PIPE, { op: "topk", by: ["url"], k: 3 }, "30m");
    assert.equal(r.logql, `topk(3, sum by (url) (count_over_time(${PIPE} [1800s])))`);
  });
});

describe("Q-LOG2: queryLogAggregate", () => {
  async function run(agg: any): Promise<any> {
    const conn = new LokiConnector();
    await conn.connect({ name: "loki", type: "loki", url: "http://loki:3100", enabled: true } as any);
    let capturedUrl = "";
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      if (u.includes("/label/") && u.includes("/values")) return jsonRes({ data: ["app"] });
      if (u.includes("/query_range")) {
        capturedUrl = u;
        return jsonRes({ data: { resultType: "matrix", result: [
          { metric: { url: "/" }, values: [[1000, "3"], [1060, "5"]] },
        ] } });
      }
      if (u.includes("/query")) {
        capturedUrl = u;
        return jsonRes({ data: { resultType: "vector", result: [
          { metric: { url: "/a" }, value: [2000, "7"] },
          { metric: { url: "/b" }, value: [2000, "12"] },
        ] } });
      }
      return jsonRes({ data: [] });
    }) as any;
    try {
      return await conn.queryLogAggregate({ service: "app", duration: "1h", ...agg });
    } finally {
      globalThis.fetch = orig;
    }
  }

  it("topk → instant vector parsed + sorted desc, note set", async () => {
    const res = await run({ op: "topk", by: ["url"], k: 2 });
    assert.equal(res.mode, "instant");
    assert.equal(res.op, "topk");
    assert.deepEqual(res.by, ["url"]);
    assert.deepEqual(res.series.map((s: any) => [s.labels.url, s.value]), [["/b", 12], ["/a", 7]]);
    assert.match(res.note, /limit/);
  });

  it("count_over_time → range matrix parsed into points", async () => {
    const res = await run({ op: "count_over_time", by: ["url"], step: "1m" });
    assert.equal(res.mode, "range");
    assert.equal(res.step, "60s");
    assert.equal(res.series.length, 1);
    assert.deepEqual(res.series[0].points, [{ t: 1000000, value: 3 }, { t: 1060000, value: 5 }]);
  });
});

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

  describe("listServices", () => {
    function withLabelValues(map: Record<string, string[]>) {
      const c = new LokiConnector() as any;
      c.serviceLabels = ["service_name", "service", "job", "app", "container"];
      c.getLabelValues = async (label: string) => map[label] ?? [];
      return c;
    }

    it("first non-empty label wins — does NOT union container aliases", async () => {
      const c = withLabelValues({
        service: ["api-gateway", "payment-service"],
        // co-located shipper noise that must NOT leak in:
        container: ["myproj-api-gateway-1", "k8s_POD_api-gateway_demo_x"],
      });
      const names = (await c.listServices()).map((s: any) => s.name).sort();
      assert.deepEqual(names, ["api-gateway", "payment-service"]);
    });

    it("falls back to a lower-priority label only when higher ones are empty", async () => {
      const c = withLabelValues({ container: ["/svc-a", "/svc-b"] });
      const svcs = await c.listServices();
      assert.deepEqual(svcs.map((s: any) => s.name).sort(), ["svc-a", "svc-b"]);
      assert.equal(svcs[0].labels.discoveredVia, "container");
    });

    it("returns empty when no candidate label has values", async () => {
      const c = withLabelValues({});
      assert.deepEqual(await c.listServices(), []);
    });
  });
});
