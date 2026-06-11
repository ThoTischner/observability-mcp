import { test } from "node:test";
import assert from "node:assert/strict";

import {
  synthesizePostmortem,
  type PostmortemInput,
  type AnomalySample,
} from "./synthesizer.js";

function input(overrides: Partial<PostmortemInput> = {}): PostmortemInput {
  return {
    service: "payment",
    window: "1h",
    tenant: "default",
    fromIso: "2026-06-06T00:00:00.000Z",
    toIso: "2026-06-06T01:00:00.000Z",
    anomalies: [],
    blastRadius: { nodes: [], edges: [] },
    traces: [],
    ...overrides,
  };
}

function anomaly(ts: string, score: number, method = "mad", severity = "warn", signal?: string): AnomalySample {
  return { ts, service: "payment", score, method, severity, signal };
}

test("synthesizePostmortem: empty input returns synopsis + 'no anomalies' follow-up", () => {
  const r = synthesizePostmortem(input());
  assert.match(r.synopsis, /No anomalies recorded/);
  assert.equal(r.sections.timeline.length, 0);
  assert.equal(r.sections.followUps.length, 1);
  assert.match(r.sections.followUps[0], /OMCP_ANOMALY_HISTORY_REMOTE_WRITE/);
});

test("synthesizePostmortem: timeline is sorted by ts ascending", () => {
  const r = synthesizePostmortem(
    input({
      anomalies: [
        anomaly("2026-06-06T00:30:00Z", 0.5),
        anomaly("2026-06-06T00:10:00Z", 0.4),
        anomaly("2026-06-06T00:50:00Z", 0.9),
      ],
    }),
  );
  assert.deepEqual(
    r.sections.timeline.map((t) => t.ts),
    ["2026-06-06T00:10:00Z", "2026-06-06T00:30:00Z", "2026-06-06T00:50:00Z"],
  );
});

test("synthesizePostmortem: contributing signals aggregated by signal label + ranked by mean score desc", () => {
  const r = synthesizePostmortem(
    input({
      anomalies: [
        anomaly("2026-06-06T00:10Z", 0.5, "mad", "warn", "request_latency"),
        anomaly("2026-06-06T00:20Z", 0.4, "mad", "warn", "request_latency"),
        anomaly("2026-06-06T00:30Z", 0.95, "seasonality", "critical", "error_rate"),
      ],
    }),
  );
  const sigs = r.sections.contributingSignals;
  assert.equal(sigs.length, 2);
  // error_rate (0.95 mean) ranks above request_latency (0.45 mean)
  assert.equal(sigs[0].signal, "error_rate");
  assert.equal(sigs[0].count, 1);
  assert.equal(sigs[0].meanScore, 0.95);
  assert.equal(sigs[1].signal, "request_latency");
  assert.equal(sigs[1].count, 2);
  assert.equal(sigs[1].meanScore, 0.45);
});

test("synthesizePostmortem: missing signal label falls back to method", () => {
  const r = synthesizePostmortem(
    input({ anomalies: [anomaly("2026-06-06T00:10Z", 0.6, "correlator")] }),
  );
  assert.equal(r.sections.contributingSignals[0].signal, "correlator");
});

test("synthesizePostmortem: critical peak triggers a follow-up mentioning the threshold", () => {
  const r = synthesizePostmortem(
    input({ anomalies: [anomaly("2026-06-06T00:30Z", 0.95)] }),
  );
  assert.ok(r.sections.followUps.some((f) => /Peak anomaly score 0\.95/.test(f)));
});

test("synthesizePostmortem: errors-in-traces triggers errorsOnly drill-in suggestion", () => {
  const r = synthesizePostmortem(
    input({
      anomalies: [anomaly("2026-06-06T00:10Z", 0.6)],
      traces: [
        { traceId: "aaa", rootName: "GET /pay", rootService: "payment", durationMs: 800, hasError: true },
      ],
    }),
  );
  assert.ok(r.sections.followUps.some((f) => /errorsOnly=true/.test(f)));
});

test("synthesizePostmortem: large blast radius triggers stale-topology hint", () => {
  const nodes = Array.from({ length: 7 }, (_, i) => ({ id: `n${i}`, kind: "pod", name: `n${i}`, root: i === 0 }));
  const r = synthesizePostmortem(
    input({
      anomalies: [anomaly("2026-06-06T00:10Z", 0.6)],
      blastRadius: { nodes, edges: [{ from: "n0", to: "n1", relation: "CALLS" }] },
    }),
  );
  assert.ok(r.sections.followUps.some((f) => /7 nodes/.test(f) && /stale topology/i.test(f)));
});

test("synthesizePostmortem: clean window returns a 'stable, consider closing' follow-up", () => {
  // The "all signals stable" branch fires only when:
  //   anomalies present (not zero)
  //   peak < 0.9
  //   no error traces
  //   blast radius <= 5
  //   no log highlights
  const r = synthesizePostmortem(
    input({
      anomalies: [anomaly("2026-06-06T00:10Z", 0.3)],
      blastRadius: { nodes: [{ id: "n0", kind: "pod", name: "n0", root: true }], edges: [] },
    }),
  );
  assert.ok(r.sections.followUps.some((f) => /stable for this window/.test(f)));
});

test("synthesizePostmortem: markdown contains every section header in order", () => {
  const r = synthesizePostmortem(
    input({
      anomalies: [anomaly("2026-06-06T00:10Z", 0.7)],
      blastRadius: {
        nodes: [{ id: "p", kind: "deployment", name: "payment", root: true }],
        edges: [{ from: "p", to: "rds", relation: "READS_FROM" }],
      },
      traces: [{ traceId: "t", rootName: "GET /pay", rootService: "payment", durationMs: 200, hasError: false }],
      logHighlights: ["payment-service: 12 5xx in window"],
    }),
  );
  for (const heading of [
    "# Post-mortem — payment",
    "## Synopsis",
    "## Anomaly timeline",
    "## Blast radius at peak",
    "## Contributing signals (ranked)",
    "## Related traces",
    "## Log highlights",
    "## Suggested follow-ups",
  ]) {
    assert.ok(r.markdown.includes(heading), `markdown missing section: ${heading}`);
  }
  // The order check — anomaly timeline should appear before blast radius
  assert.ok(r.markdown.indexOf("## Anomaly timeline") < r.markdown.indexOf("## Blast radius at peak"));
});

test("synthesizePostmortem: timeline > 20 rows is truncated with an ellipsis row", () => {
  const anomalies: AnomalySample[] = Array.from({ length: 25 }, (_, i) =>
    anomaly(`2026-06-06T00:${String(i).padStart(2, "0")}:00Z`, 0.5 + i * 0.01),
  );
  const r = synthesizePostmortem(input({ anomalies }));
  // The structured section has all 25
  assert.equal(r.sections.timeline.length, 25);
  // The markdown table is capped at 20 data rows + an ellipsis row
  // — count rows specifically inside the Anomaly timeline section
  // (other sections also use | ` ... | tables and would inflate a
  // global grep).
  const md = r.markdown;
  const timelineStart = md.indexOf("## Anomaly timeline");
  const blastStart = md.indexOf("## Blast radius at peak");
  const timelineSection = md.slice(timelineStart, blastStart);
  const tableRows = timelineSection.split("\n").filter((l) => l.startsWith("| `")).length;
  assert.equal(tableRows, 20);
  assert.match(timelineSection, /_5 more rows_/);
});

test("synthesizePostmortem: report carries the input window + iso bounds back into the structured shape", () => {
  const r = synthesizePostmortem(input({ window: "6h" }));
  assert.equal(r.service, "payment");
  assert.equal(r.window, "6h");
  assert.equal(r.fromIso, "2026-06-06T00:00:00.000Z");
  assert.equal(r.toIso, "2026-06-06T01:00:00.000Z");
});

test("custom template: tokens are interpolated; default path unchanged when no template", () => {
  const data = input({
    anomalies: [anomaly("2026-06-06T00:10:00Z", 0.7, "mad", "warn", "cpu")],
    blastRadius: { nodes: [{ id: "n1", kind: "pod", name: "payment-1", root: true }], edges: [] },
    logHighlights: ["payment: 5xx spike"],
  });
  // Default (no template) still produces the built-in report.
  const def = synthesizePostmortem(data);
  assert.match(def.markdown, /^# Post-mortem — payment/);

  // Custom template interpolates the known tokens.
  const tpl = "INCIDENT {{service}} ({{window}})\n\n{{synopsis}}\n\nTIMELINE:\n{{timeline}}\n\nFOLLOWUPS:\n{{followUps}}\n\nLOGS:\n{{logHighlights}}";
  const out = synthesizePostmortem({ ...data, template: tpl }).markdown;
  assert.match(out, /^INCIDENT payment \(1h\)/);
  assert.ok(!out.includes("# Post-mortem"), "custom template replaces the default layout");
  assert.match(out, /TIMELINE:\n\| ts \| service \| score/);
  assert.match(out, /LOGS:\n- payment: 5xx spike/);
  assert.ok(out.includes(def.synopsis), "synopsis token expands to the computed synopsis");
});

test("custom template: unknown token is left verbatim (visible typo, not silent blank)", () => {
  const out = synthesizePostmortem({ ...input(), template: "{{service}} / {{nope}}" }).markdown;
  assert.equal(out, "payment / {{nope}}");
});

test("custom template: empty sections render their placeholder text, not a crash", () => {
  const out = synthesizePostmortem({ ...input(), template: "T:{{timeline}} L:{{logHighlights}}" }).markdown;
  assert.match(out, /T:_No anomaly samples in this window\._/);
  assert.match(out, /L:_No log highlights\._/);
});
