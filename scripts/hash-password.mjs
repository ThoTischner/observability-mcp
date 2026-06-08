#!/usr/bin/env node
// Mint a scrypt-hashed entry for the local users file consumed by
// OMCP_AUTH=basic. Run via:
//
//   node scripts/hash-password.mjs alice
//
// Prompts for the password on stderr (so the hash on stdout pipes cleanly).
// Emits a single JSON object the operator can paste under the `users:` key
// of OMCP_USERS_FILE.
//
// Uses ONLY node's built-in scrypt — no dependency on the mcp-server build
// output, so this script works straight from a source checkout.

import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline";
import { stdin, stdout, stderr, argv, exit } from "node:process";

const DEFAULT_N = 1 << 15;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const KEYLEN = 32;

// --- Password policy ---------------------------------------------------
// Mirror of mcp-server/src/auth/password-policy.ts (DEFAULT_PASSWORD_POLICY
// + denylist). Duplicated here on purpose: this script stays dependency-
// free and runnable from a source checkout, exactly like the scrypt params
// above. Keep the two in sync — password-policy.test.ts is the canonical
// spec. Override via the same OMCP_PASSWORD_* env vars; skip with --force.
const PW_MIN_LENGTH = numEnv("OMCP_PASSWORD_MIN_LENGTH", 12);
const PW_MAX_LENGTH = 1024;
const PW_MIN_CLASSES = numEnv("OMCP_PASSWORD_MIN_CLASSES", 3);
const PW_DENYLIST_DISABLED = truthyEnv("OMCP_PASSWORD_DENYLIST_DISABLED");
const PW_POLICY_DISABLED = truthyEnv("OMCP_PASSWORD_POLICY_DISABLED");
const PW_DENYLIST = new Set([
  "password", "password1", "password123", "passw0rd", "p@ssw0rd", "p@ssword",
  "123456", "1234567", "12345678", "123456789", "1234567890", "12345",
  "qwerty", "qwerty123", "qwertyuiop", "asdfghjkl", "1q2w3e4r", "1qaz2wsx",
  "letmein", "welcome", "welcome1", "admin", "admin123", "administrator",
  "root", "toor", "changeme", "default", "guest", "iloveyou", "monkey",
  "dragon", "sunshine", "princess", "football", "baseball", "abc123",
  "654321", "111111", "000000", "superman", "trustno1", "master",
  "hello123", "secret", "test", "test123", "user", "login", "passport",
  "observability", "observability-mcp", "prometheus", "grafana", "loki",
]);

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
function truthyEnv(name) {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
function codePointLength(s) {
  let n = 0;
  for (const _ of s) n++;
  return n;
}
function countClasses(pw) {
  let lower = false, upper = false, digit = false, symbol = false;
  for (const ch of pw) {
    if (ch >= "a" && ch <= "z") lower = true;
    else if (ch >= "A" && ch <= "Z") upper = true;
    else if (ch >= "0" && ch <= "9") digit = true;
    else symbol = true;
  }
  return Number(lower) + Number(upper) + Number(digit) + Number(symbol);
}
function validatePassword(password, username) {
  const errors = [];
  const len = codePointLength(password);
  if (len < PW_MIN_LENGTH) errors.push(`must be at least ${PW_MIN_LENGTH} characters (got ${len})`);
  if (len > PW_MAX_LENGTH) errors.push(`must be at most ${PW_MAX_LENGTH} characters`);
  if (PW_MIN_CLASSES > 1) {
    const classes = countClasses(password);
    if (classes < PW_MIN_CLASSES) {
      errors.push(`must mix at least ${PW_MIN_CLASSES} of: lowercase, uppercase, digit, symbol (got ${classes})`);
    }
  }
  if (!PW_DENYLIST_DISABLED && PW_DENYLIST.has(password.toLowerCase())) {
    errors.push("is on the common-password denylist");
  }
  if (username) {
    const u = username.toLowerCase();
    if (u.length >= 3 && password.toLowerCase().includes(u)) errors.push("must not contain the username");
  }
  return errors;
}

function hashPassword(plaintext, opts = {}) {
  const N = opts.N ?? DEFAULT_N;
  const r = opts.r ?? DEFAULT_R;
  const p = opts.p ?? DEFAULT_P;
  const salt = randomBytes(16);
  const hash = scryptSync(plaintext, salt, KEYLEN, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function readPasswordHidden(promptText) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      // Non-TTY (pipe / heredoc): just read one line, no masking.
      const rl = createInterface({ input: stdin });
      let got = false;
      rl.once("line", (line) => { got = true; rl.close(); resolve(line); });
      rl.once("close", () => { if (!got) reject(new Error("stdin closed without input")); });
      return;
    }
    stderr.write(promptText);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    function onData(ch) {
      switch (ch) {
        case "\n":
        case "\r":
        case "\u0004": // Ctrl-D (EOF)
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          stderr.write("\n");
          resolve(buf);
          return;
        case "\u0003": // Ctrl-C
          stdin.setRawMode(false);
          stderr.write("\n");
          exit(130);
          return;
        case "\u007f": // DEL
        case "\b":
          if (buf.length > 0) buf = buf.slice(0, -1);
          return;
        default:
          buf += ch;
      }
    }
    stdin.on("data", onData);
  });
}

function parseArgs(args) {
  const out = { positional: [], name: null, roles: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--name") out.name = args[++i];
    else if (a.startsWith("--name=")) out.name = a.slice(7);
    else if (a === "--roles") out.roles = args[++i];
    else if (a.startsWith("--roles=")) out.roles = a.slice(8);
    else if (a === "--force") out.force = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else out.positional.push(a);
  }
  return out;
}

function usage() {
  stderr.write(
`Usage: node scripts/hash-password.mjs <username> [--name "Display Name"] [--roles operator,viewer] [--force]

Reads the password from stdin (TTY-masked when interactive). Prints a JSON
object suitable for inclusion under the "users:" key of OMCP_USERS_FILE.

The password is checked against the policy (min length / character classes /
common-password denylist; tune with OMCP_PASSWORD_* env vars). Pass --force
or set OMCP_PASSWORD_POLICY_DISABLED=true to skip the check.
`,
  );
}

async function main() {
  const args = parseArgs(argv.slice(2));
  if (args.help || args.positional.length === 0) { usage(); exit(args.help ? 0 : 2); }
  const username = args.positional[0];
  if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/i.test(username)) {
    stderr.write(`username "${username}" must be 1-63 chars, alnum + . _ -\n`);
    exit(2);
  }
  const name = args.name || username;
  const roles = args.roles
    ? args.roles.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const password = await readPasswordHidden(`Password for ${username}: `);
  if (!password) { stderr.write("empty password — aborting\n"); exit(2); }
  if (!PW_POLICY_DISABLED && !args.force) {
    const violations = validatePassword(password, username);
    if (violations.length > 0) {
      stderr.write("password rejected by policy:\n");
      for (const v of violations) stderr.write(`  - ${v}\n`);
      stderr.write("Use a stronger password, or pass --force / set OMCP_PASSWORD_POLICY_DISABLED=true to override.\n");
      exit(2);
    }
  }
  const passwordHash = hashPassword(password);
  const entry = { username, name, ...(roles.length ? { roles } : {}), passwordHash };
  stdout.write(JSON.stringify(entry, null, 2) + "\n");
}

main().catch((e) => { stderr.write(String(e?.stack || e) + "\n"); exit(1); });
