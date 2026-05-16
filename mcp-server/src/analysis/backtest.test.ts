import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSuite, runBacktest, formatReport } from "./backtest.js";

// CI quality gate. The suite is deterministic (seeded), so these bounds are
// stable; a detector change that regresses precision/recall fails CI here.
// The README "Detection quality" table is regenerated from this same suite.
describe("anomaly backtest — quality gate", () => {
  const report = runBacktest(buildSuite());

  it("suite is non-trivial and balanced", () => {
    assert.ok(report.total >= 60, `expected ≥60 labelled cases, got ${report.total}`);
    const positives = report.tp + report.fn;
    const negatives = report.tn + report.fp;
    assert.ok(positives >= 20 && negatives >= 20, "suite must have enough of both classes");
  });

  it("precision ≥ 0.95 (no spurious alerts)", () => {
    assert.ok(
      report.precision >= 0.95,
      `precision ${report.precision.toFixed(3)} below gate\n${formatReport(report)}`
    );
  });

  it("recall ≥ 0.80", () => {
    assert.ok(
      report.recall >= 0.8,
      `recall ${report.recall.toFixed(3)} below gate\n${formatReport(report)}`
    );
  });

  it("F1 ≥ 0.88", () => {
    assert.ok(
      report.f1 >= 0.88,
      `F1 ${report.f1.toFixed(3)} below gate\n${formatReport(report)}`
    );
  });

  it("clean regimes are detected perfectly (no regression)", () => {
    for (const regime of ["slow-ramp", "spike", "step", "stable", "transient", "one-sided", "seasonal"]) {
      const c = report.byCategory[regime];
      assert.ok(c, `missing category ${regime}`);
      assert.equal(c.correct, c.total, `${regime}: ${c.correct}/${c.total} — regression\n${formatReport(report)}`);
    }
  });

  it("prints the report (visible in CI logs)", () => {
    console.log("\n" + formatReport(report) + "\n");
  });
});
