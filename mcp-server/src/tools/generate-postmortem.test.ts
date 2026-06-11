import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorRegistry } from "../connectors/registry.js";
import { generatePostmortemHandler, _resetPostmortemTemplateCache } from "./generate-postmortem.js";

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

describe("generatePostmortemHandler — custom template via OMCP_POSTMORTEM_TEMPLATE (C3)", () => {
  it("renders the operator's template when the env file is set; falls back when unset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-tpl-"));
    const file = join(dir, "tpl.md");
    writeFileSync(file, "## Incident: {{service}} over {{window}}\n\n{{synopsis}}");
    const prev = process.env.OMCP_POSTMORTEM_TEMPLATE;
    try {
      process.env.OMCP_POSTMORTEM_TEMPLATE = file;
      _resetPostmortemTemplateCache();
      const reg = new ConnectorRegistry();
      const md = (await generatePostmortemHandler(reg, { service: "payment", duration: "2h" })).content[0].text;
      // The custom template body is used (the no-signal honesty banner may
      // still prepend it — that's deliberate and template-independent).
      assert.match(md, /## Incident: payment over 2h/);
      assert.ok(!md.includes("# Post-mortem —"), "custom template replaces the default layout");

      // Unset → back to the built-in layout.
      delete process.env.OMCP_POSTMORTEM_TEMPLATE;
      _resetPostmortemTemplateCache();
      const md2 = (await generatePostmortemHandler(reg, { service: "payment", duration: "2h" })).content[0].text;
      assert.match(md2, /# Post-mortem — payment/);
    } finally {
      if (prev === undefined) delete process.env.OMCP_POSTMORTEM_TEMPLATE;
      else process.env.OMCP_POSTMORTEM_TEMPLATE = prev;
      _resetPostmortemTemplateCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unreadable template path falls back to the default layout, doesn't throw", async () => {
    const prev = process.env.OMCP_POSTMORTEM_TEMPLATE;
    try {
      process.env.OMCP_POSTMORTEM_TEMPLATE = "/nonexistent/nope.md";
      _resetPostmortemTemplateCache();
      const md = (await generatePostmortemHandler(new ConnectorRegistry(), { service: "x", duration: "1h" })).content[0].text;
      assert.match(md, /# Post-mortem — x/);
    } finally {
      if (prev === undefined) delete process.env.OMCP_POSTMORTEM_TEMPLATE;
      else process.env.OMCP_POSTMORTEM_TEMPLATE = prev;
      _resetPostmortemTemplateCache();
    }
  });
});
