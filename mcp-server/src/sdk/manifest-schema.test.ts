import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { manifestSchema } from "./manifest-schema.js";

const minimal = {
  schemaVersion: 1 as const,
  name: "prometheus",
  displayName: "Prometheus",
  version: "1.0.0",
  description: "PromQL backend",
  signalTypes: ["metrics" as const],
};

describe("manifestSchema", () => {
  it("accepts a minimal valid manifest", () => {
    const r = manifestSchema.safeParse(minimal);
    assert.equal(r.success, true);
  });

  it("rejects schemaVersion != 1", () => {
    const r = manifestSchema.safeParse({ ...minimal, schemaVersion: 2 });
    assert.equal(r.success, false);
  });

  it("rejects non-kebab names", () => {
    const r = manifestSchema.safeParse({ ...minimal, name: "Prometheus_X" });
    assert.equal(r.success, false);
  });

  it("rejects non-semver versions", () => {
    const r = manifestSchema.safeParse({ ...minimal, version: "v1.0" });
    assert.equal(r.success, false);
  });

  it("requires at least one signalType", () => {
    const r = manifestSchema.safeParse({ ...minimal, signalTypes: [] });
    assert.equal(r.success, false);
  });

  it("rejects unknown signalType", () => {
    const r = manifestSchema.safeParse({ ...minimal, signalTypes: ["spans"] });
    assert.equal(r.success, false);
  });

  it("accepts a fully-populated manifest", () => {
    const full = {
      ...minimal,
      homepage: "https://example.com/connector-prom",
      license: "MIT",
      logo: "./logo.svg",
      configSchema: { type: "object" },
      capabilities: { queryMetrics: true, listServices: true },
      compat: { serverVersion: ">=1.4.0" },
    };
    const r = manifestSchema.safeParse(full);
    assert.equal(r.success, true);
  });
});
