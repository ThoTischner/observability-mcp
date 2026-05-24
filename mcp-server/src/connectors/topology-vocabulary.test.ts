import test from "node:test";
import assert from "node:assert/strict";

import {
  KINDS,
  RELATIONS,
  isKnownKind,
  isKnownRelation,
  validateResource,
  validateEdge,
  validateSnapshot,
} from "./topology-vocabulary.js";

test("vocabulary — KINDS and RELATIONS contain what the kubernetes connector emits today", () => {
  for (const k of ["pod", "node", "deployment", "replicaset", "namespace"]) {
    assert.equal(isKnownKind(k), true, `kind "${k}" must be in the canonical vocabulary`);
  }
  for (const r of ["RUNS_ON", "OWNED_BY", "IN_NAMESPACE"]) {
    assert.equal(isKnownRelation(r), true, `relation "${r}" must be in the canonical vocabulary`);
  }
});

test("vocabulary — CALLS is reserved for the upcoming trace connector", () => {
  assert.equal(isKnownRelation("CALLS"), true);
});

test("validateResource — canonical kinds produce no warnings", () => {
  for (const k of KINDS) {
    assert.deepEqual(validateResource({ kind: k }), []);
  }
});

test("validateResource — unknown kind warns", () => {
  const w = validateResource({ kind: "frobnicator" });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, "unknown_resource_kind");
  assert.equal(w[0].value, "frobnicator");
});

test("validateResource — uppercase kind triggers a case-mismatch hint", () => {
  const w = validateResource({ kind: "Pod" });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, "case_mismatch");
  assert.match(w[0].message, /lowercase "pod"/);
});

test("validateEdge — canonical relations produce no warnings", () => {
  for (const r of RELATIONS) {
    assert.deepEqual(validateEdge({ relation: r }), []);
  }
});

test("validateEdge — unknown relation warns", () => {
  const w = validateEdge({ relation: "FROBNICATES" });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, "unknown_relation");
});

test("validateEdge — lowercase relation triggers a case-mismatch hint", () => {
  const w = validateEdge({ relation: "runs_on" });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, "case_mismatch");
  assert.match(w[0].message, /UPPER_SNAKE "RUNS_ON"/);
});

test("validateSnapshot — de-duplicates repeated offenders", () => {
  const warnings = validateSnapshot(
    [
      { kind: "frobnicator" },
      { kind: "frobnicator" },
      { kind: "pod" },
    ],
    [
      { relation: "FROBNICATES" },
      { relation: "FROBNICATES" },
      { relation: "RUNS_ON" },
    ],
  );
  assert.equal(warnings.length, 2, `expected one warning per distinct offender, got ${warnings.length}`);
});

test("validateSnapshot — a fully canonical snapshot is silent", () => {
  const warnings = validateSnapshot(
    [{ kind: "pod" }, { kind: "node" }, { kind: "deployment" }],
    [{ relation: "RUNS_ON" }, { relation: "OWNED_BY" }, { relation: "IN_NAMESPACE" }],
  );
  assert.deepEqual(warnings, []);
});
