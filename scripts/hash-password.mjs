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
    else if (a === "-h" || a === "--help") out.help = true;
    else out.positional.push(a);
  }
  return out;
}

function usage() {
  stderr.write(
`Usage: node scripts/hash-password.mjs <username> [--name "Display Name"] [--roles operator,viewer]

Reads the password from stdin (TTY-masked when interactive). Prints a JSON
object suitable for inclusion under the "users:" key of OMCP_USERS_FILE.
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
  const passwordHash = hashPassword(password);
  const entry = { username, name, ...(roles.length ? { roles } : {}), passwordHash };
  stdout.write(JSON.stringify(entry, null, 2) + "\n");
}

main().catch((e) => { stderr.write(String(e?.stack || e) + "\n"); exit(1); });
