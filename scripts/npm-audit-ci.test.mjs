// End-to-end tests for the npm-audit-ci wrapper. Each case spawns the real
// script with a fake `npm` on PATH, so the retry/classification logic is
// exercised through the same spawnSync path CI uses — not mocked out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, chmod, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "npm-audit-ci.mjs");

/** A fake `npm` that emits scripted responses, one per invocation.
 *  Each response is {stdout, stderr, code}; the last one repeats. */
async function withFakeNpm(responses, run) {
  const dir = await mkdtemp(join(tmpdir(), "npm-audit-ci-"));
  const binDir = join(dir, "bin");
  const stateFile = join(dir, "calls");
  await mkdir(binDir, { recursive: true });
  await writeFile(join(dir, "responses.json"), JSON.stringify(responses));

  // Node shim rather than shell quoting gymnastics around JSON payloads.
  const shim = `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const responses = JSON.parse(readFileSync(${JSON.stringify(join(dir, "responses.json"))}, "utf8"));
const stateFile = ${JSON.stringify(stateFile)};
const n = existsSync(stateFile) ? Number(readFileSync(stateFile, "utf8")) : 0;
writeFileSync(stateFile, String(n + 1));
const r = responses[Math.min(n, responses.length - 1)];
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.code ?? 0);
`;
  await writeFile(join(binDir, "npm.mjs"), shim);
  await writeFile(join(binDir, "npm"), `#!/bin/sh\nexec "${process.execPath}" "${join(binDir, "npm.mjs")}" "$@"\n`);
  await chmod(join(binDir, "npm"), 0o755);

  try {
    return await run({ binDir, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runScript(binDir, cwd, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, cwd], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      OMCP_AUDIT_BACKOFF_MS: "1",
      OMCP_AUDIT_ATTEMPTS: "3",
      ...extraEnv,
    },
  });
}

const clean = {
  stdout: JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 2, moderate: 0, high: 0, critical: 0, total: 2 } } }),
  code: 0,
};

const vulnerable = {
  stdout: JSON.stringify({
    vulnerabilities: {
      "js-yaml": {
        severity: "high",
        range: "4.0.0 - 4.3.0",
        fixAvailable: { name: "js-yaml", version: "4.3.2" },
        via: [{ title: "Quadratic CPU consumption in !!omap", url: "https://github.com/advisories/GHSA-5p4m-2wfm-xmqj" }],
      },
    },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
  }),
  code: 1,
};

// The exact shape of the 2026-09-04 outage: npm emits a JSON error object.
const outage = {
  stdout: JSON.stringify({ error: { code: "ENOAUDIT", summary: "503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick", detail: "audit endpoint returned an error" } }),
  code: 1,
};

// npm failing before it can produce JSON at all — plain text on stderr.
const outageTextOnly = {
  stdout: "",
  stderr: "npm warn audit 503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick\nnpm error audit endpoint returned an error\n",
  code: 1,
};

test("clean tree exits 0", async () => {
  await withFakeNpm([clean], async ({ binDir, dir }) => {
    const r = runScript(binDir, dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /clean at level 'high'/);
  });
});

test("high-severity vulnerability exits 1 and names the package", async () => {
  await withFakeNpm([vulnerable], async ({ binDir, dir }) => {
    const r = runScript(binDir, dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /js-yaml \(high\)/);
    assert.match(r.stdout, /fix: js-yaml@4\.3\.2/);
    assert.match(r.stdout, /GHSA-5p4m-2wfm-xmqj/);
  });
});

test("moderate-only tree passes at --level high", async () => {
  const moderateOnly = {
    stdout: JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 4, high: 0, critical: 0, total: 4 } } }),
    code: 1, // npm still exits non-zero; the threshold decision is ours
  };
  await withFakeNpm([moderateOnly], async ({ binDir, dir }) => {
    const r = runScript(binDir, dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

test("transient outage then success: retries and passes", async () => {
  await withFakeNpm([outage, outage, clean], async ({ binDir, dir }) => {
    const r = runScript(binDir, dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /attempt 1\/3/);
    assert.match(r.stdout, /attempt 2\/3/);
    assert.match(r.stdout, /clean at level 'high'/);
  });
});

test("outage reported only on stderr is still classified as infrastructure", async () => {
  await withFakeNpm([outageTextOnly, clean], async ({ binDir, dir }) => {
    const r = runScript(binDir, dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /advisory endpoint unavailable/);
  });
});

test("persistent outage exits 2, distinct from a vulnerability, and says so", async () => {
  await withFakeNpm([outage], async ({ binDir, dir }) => {
    const r = runScript(binDir, dir);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /FAILED TO REACH the npm advisory endpoint after 3 attempts/);
    assert.match(r.stdout, /NOT a vulnerability in this repository/);
    // Fixed string, not a regex: an unanchored hostname pattern reads to
    // CodeQL (js/regex/missing-regexp-anchor) like a URL check that any
    // host could slip past. It is only an assertion on our own output.
    assert.ok(r.stdout.includes("https://status.npmjs.org/"), r.stdout);
  });
});

test("an outage never masks a real finding — retry that surfaces vulns exits 1", async () => {
  await withFakeNpm([outage, vulnerable], async ({ binDir, dir }) => {
    const r = runScript(binDir, dir);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /js-yaml \(high\)/);
  });
});

test("unexpected npm failure is surfaced, not retried away as an outage", async () => {
  const broken = { stdout: "", stderr: "npm error code EJSONPARSE\nnpm error Invalid package.json\n", code: 1 };
  await withFakeNpm([broken], async ({ binDir, dir }) => {
    const r = runScript(binDir, dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /unexpected failure/);
    assert.doesNotMatch(r.stdout, /advisory endpoint unavailable/);
  });
});

test("rejects an unknown --level instead of silently auditing at the wrong threshold", async () => {
  await withFakeNpm([clean], async ({ binDir, dir }) => {
    const r = spawnSync(process.execPath, [SCRIPT, dir, "--level", "spicy"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown --level 'spicy'/);
  });
});

// --- Regression: the shape that broke this wrapper on its first CI run ---
// npm reports an audit failure with the reason in the TOP-LEVEL "message"
// and a completely blank error object. Reading error.* alone produced an
// empty string and the useless line "unexpected failure — ", which then
// exited 1 (a vulnerability!) on what was really an outage.

const outageBlankErrorObject = {
  stdout: JSON.stringify({
    message: "503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick",
    error: { summary: "", detail: "" },
  }),
  code: 1,
};

test("outage with blank error object and reason in top-level message is classified as infrastructure", async () => {
  await withFakeNpm([outageBlankErrorObject], async ({ binDir, dir }) => {
    const r = runScript(binDir, dir);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /503 Service Unavailable/);
    assert.doesNotMatch(r.stdout, /unexpected failure/);
  });
});

test("a blank error object never yields an empty detail line", async () => {
  // Same blank-error shape, but a reason that is genuinely not an outage:
  // must still fail as 'unexpected', and must still say why.
  const configBug = {
    stdout: JSON.stringify({
      message: "minTimeout is greater than maxTimeout",
      error: { summary: "", detail: "" },
    }),
    code: 1,
  };
  await withFakeNpm([configBug], async ({ binDir, dir }) => {
    const r = runScript(binDir, dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /unexpected failure — minTimeout is greater than maxTimeout/);
    assert.doesNotMatch(r.stdout, /unexpected failure — *$/m);
  });
});

test("totally empty npm output still produces a readable reason", async () => {
  await withFakeNpm([{ stdout: "", stderr: "", code: 1 }], async ({ binDir, dir }) => {
    const r = runScript(binDir, dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /no parseable report \(exit 1\)/);
  });
});
