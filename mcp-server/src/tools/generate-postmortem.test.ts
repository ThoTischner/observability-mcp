import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConnectorRegistry } from "../connectors/registry.js";
import { generatePostmortemHandler } from "./generate-postmortem.js";

// R5 — a post-mortem built from ZERO signal (no anomaly/traces/topology/log
// backend) must label itself, not render as an authoritative finding.
describe("generatePostmortemHandler — no-signal honesty (R5)", () => {
  it("markdown leads with a 'no signal' banner when nothing was found", async () => {
    const reg = new ConnectorRegistry(); // no backends → every primitive empty
    const out = await generatePostmortemHandler(reg, { service: "ghost-service", duration: "1h" });
    const md = out.content[0].text;
    assert.match(md, /No signal in this window/i);
    assert.match(md, /backends aren't configured/i);
  });

  it("json form carries explicit coverage flags + builtFromSignal=false", async () => {
    const reg = new ConnectorRegistry();
    const out = await generatePostmortemHandler(reg, { service: "ghost-service", duration: "1h", format: "json" });
    const report = JSON.parse(out.content[0].text);
    assert.equal(report.builtFromSignal, false);
    assert.deepEqual(report.coverage, { anomalies: false, traces: false, topology: false, logs: false });
  });
});
