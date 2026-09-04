#!/usr/bin/env node
// CI wrapper around `npm audit` that separates the two failures the bare
// command conflates: "this tree has vulnerabilities" (our problem, must
// block) and "npmjs.org's audit endpoint is down" (not our problem, and
// blocking on it just trains people to ignore a red pipeline).
//
// The nightly scan went red on 2026-09-04 with
//   npm warn audit 503 Service Unavailable - POST .../security/audits/quick
//   npm error audit endpoint returned an error
// after burning 7m11s inside a single `npm audit` call — npm's own fetch
// retries. Same commit, same lockfile, mcp-server green and agent red:
// pure luck which matrix leg hit the outage.
//
// So: cap npm's internal retrying, drive the retries from here with
// backoff, and classify the outcome explicitly.
//
// Exit codes
//   0  clean at or above the threshold
//   1  vulnerabilities found at or above the threshold  (real finding)
//   2  audit endpoint unreachable after every attempt   (infrastructure)
//
// 2 still fails the job — a scan that cannot see the advisory database
// has proven nothing, and silently passing it would hide the next real
// CVE. It is a distinct code with a distinct message so a human reading
// the log knows in one line whether to look at the lockfile or at
// status.npmjs.org.

import { spawnSync } from "node:child_process";
import { argv, env, exit, stderr, stdout } from "node:process";

const SEVERITIES = ["info", "low", "moderate", "high", "critical"];

// npm retries fetches internally; left at its defaults a single attempt
// can hang for minutes, which is exactly what made the outage so slow to
// surface. Keep each attempt short and let the loop below own the waiting.
const NPM_FETCH_ARGS = [
  "--fetch-retries", "1",
  "--fetch-retry-mintimeout", "1000",
  "--fetch-retry-maxtimeout", "8000",
];

/** Advisory-endpoint failure signatures. npm reports these as a JSON
 *  `error` object on stdout, or as plain text on stderr when it fails
 *  before it can produce JSON at all. */
const ENDPOINT_ERROR_RE =
  /audit endpoint|ENOAUDIT|Service Unavailable|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|502 Bad Gateway|503|504 Gateway/i;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Counts at or above `level`, from npm's metadata.vulnerabilities block. */
export function countAtOrAbove(vulnerabilities, level) {
  const from = SEVERITIES.indexOf(level);
  if (from < 0) throw new Error(`unknown audit level: ${level}`);
  let n = 0;
  for (const sev of SEVERITIES.slice(from)) n += vulnerabilities?.[sev] ?? 0;
  return n;
}

/** Human-readable advisory list, so a failing run stays as actionable as
 *  the plain `npm audit` output it replaces. */
export function formatFindings(report, level) {
  const from = SEVERITIES.indexOf(level);
  const lines = [];
  for (const [name, v] of Object.entries(report?.vulnerabilities ?? {})) {
    if (SEVERITIES.indexOf(v.severity) < from) continue;
    const via = (v.via ?? []).filter((x) => typeof x === "object");
    const title = via[0]?.title ?? "(no title)";
    const url = via[0]?.url ?? "";
    const fix = v.fixAvailable === true ? "fix available"
      : v.fixAvailable?.name ? `fix: ${v.fixAvailable.name}@${v.fixAvailable.version}`
      : "no fix available";
    lines.push(`  ${name} (${v.severity}) — ${title}`);
    lines.push(`    range: ${v.range} | ${fix}${url ? ` | ${url}` : ""}`);
  }
  return lines.join("\n");
}

/** One `npm audit --json` attempt, classified. */
export function attemptAudit({ cwd, level, timeoutMs, npmBin = "npm" }) {
  const res = spawnSync(
    npmBin,
    ["audit", "--json", "--audit-level", level, ...NPM_FETCH_ARGS],
    { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
  );

  if (res.error?.code === "ETIMEDOUT" || res.signal) {
    return { kind: "endpoint", detail: `attempt exceeded ${timeoutMs}ms (${res.signal ?? res.error?.code})` };
  }
  if (res.error) {
    return { kind: "fatal", detail: `could not run ${npmBin}: ${res.error.message}` };
  }

  const stdoutText = res.stdout ?? "";
  const stderrText = (res.stderr ?? "").trim();
  const report = parseJson(stdoutText);

  if (report?.metadata?.vulnerabilities) return { kind: "report", report };

  // No usable report. npm describes an audit failure as
  //   {"message": "<reason>", "error": {"summary": "", "detail": ""}}
  // — the reason sits in the TOP-LEVEL message and the error object is
  // often entirely blank, so picking through error.* alone yields an
  // empty string and an unreadable "unexpected failure —" line (which is
  // exactly how this wrapper failed on its first CI run). Take the first
  // field that actually carries text, and match against everything npm
  // emitted rather than one hand-picked field.
  const firstNonEmpty = (...vals) => vals.map((v) => (v == null ? "" : String(v).trim())).find((v) => v !== "") ?? "";
  const detail = firstNonEmpty(
    report?.message,
    report?.error?.detail,
    report?.error?.summary,
    report?.error?.code,
    report?.error && Object.keys(report.error).length ? JSON.stringify(report.error) : "",
    stderrText.split("\n").slice(0, 3).join(" | "),
    `npm audit produced no parseable report (exit ${res.status})`,
  );

  const haystack = [detail, stderrText, stdoutText.slice(0, 4096)].join("\n");
  return ENDPOINT_ERROR_RE.test(haystack)
    ? { kind: "endpoint", detail }
    : { kind: "fatal", detail };
}

export function runAudit({ cwd, level = "high", attempts = 4, backoffMs = 15000, timeoutMs = 120000, npmBin = "npm", sleep = defaultSleep, log = (m) => stdout.write(m + "\n") }) {
  let last = null;
  for (let i = 1; i <= attempts; i++) {
    const out = attemptAudit({ cwd, level, timeoutMs, npmBin });

    if (out.kind === "report") {
      const counts = out.report.metadata.vulnerabilities;
      const n = countAtOrAbove(counts, level);
      if (n === 0) {
        log(`npm audit (${cwd}): clean at level '${level}' — ${counts.total ?? 0} advisories total, none at or above ${level}.`);
        return 0;
      }
      log(`npm audit (${cwd}): ${n} vulnerability(ies) at or above '${level}':\n${formatFindings(out.report, level)}`);
      log(`\nRaise the override floor to the patched version and regenerate the lockfile.`);
      return 1;
    }

    if (out.kind === "fatal") {
      log(`npm audit (${cwd}): unexpected failure — ${out.detail}`);
      return 1;
    }

    last = out.detail;
    log(`npm audit (${cwd}): advisory endpoint unavailable (attempt ${i}/${attempts}) — ${out.detail}`);
    if (i < attempts) {
      const wait = backoffMs * 2 ** (i - 1);
      log(`  retrying in ${Math.round(wait / 1000)}s`);
      sleep(wait);
    }
  }

  log(
    `\nnpm audit (${cwd}): FAILED TO REACH the npm advisory endpoint after ${attempts} attempts.\n` +
    `Last error: ${last}\n` +
    `This is an npm registry problem, NOT a vulnerability in this repository —\n` +
    `check https://status.npmjs.org/ and re-run. Nothing about the lockfile changed.`,
  );
  return 2;
}

function defaultSleep(ms) {
  // Synchronous sleep keeps the script a straight-line CLI; the waits are
  // seconds, and this only ever runs in CI.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main() {
  const args = argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };

  const cwd = positional[0] ?? ".";
  const level = flag("level", "high");
  const attempts = Number(env.OMCP_AUDIT_ATTEMPTS ?? flag("attempts", "4"));
  const backoffMs = Number(env.OMCP_AUDIT_BACKOFF_MS ?? flag("backoff-ms", "15000"));
  const timeoutMs = Number(env.OMCP_AUDIT_TIMEOUT_MS ?? flag("timeout-ms", "120000"));

  if (!SEVERITIES.includes(level)) {
    stderr.write(`unknown --level '${level}' (expected one of: ${SEVERITIES.join(", ")})\n`);
    exit(1);
  }
  exit(runAudit({ cwd, level, attempts, backoffMs, timeoutMs }));
}

// Only run as a CLI, so the test file can import the pieces above.
if (import.meta.url === `file://${argv[1]}`) main();
