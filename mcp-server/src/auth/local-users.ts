/**
 * File-backed local user store for the management-plane "basic" auth mode.
 *
 * Password verification uses node's built-in `scrypt` so the server has no
 * extra runtime dependency. The on-disk format is a small JSON document:
 *
 *   {
 *     "users": [
 *       {
 *         "username": "alice",
 *         "name": "Alice Operator",
 *         "roles": ["operator"],
 *         "passwordHash": "scrypt$N$r$p$<salt-b64>$<hash-b64>"
 *       },
 *       ...
 *     ]
 *   }
 *
 * The `passwordHash` field uses the PHC-like format `scrypt$N$r$p$salt$hash`,
 * which encodes the cost parameters alongside the digest so operators can
 * rotate them without breaking existing entries.
 *
 * Use `hashPassword()` to mint a new entry, e.g. from a one-shot CLI helper.
 */

import { promises as fs } from "node:fs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export interface LocalUser {
  username: string;
  name: string;
  roles?: string[];
  /** Optional tenant assignment. Missing → DEFAULT_TENANT. */
  tenant?: string;
  passwordHash: string;
}

export interface LocalUsersFile {
  users: LocalUser[];
}

/** Default scrypt cost — N=2^15, r=8, p=1. Matches OWASP 2023 baseline. */
export const DEFAULT_SCRYPT_N = 1 << 15;
export const DEFAULT_SCRYPT_R = 8;
export const DEFAULT_SCRYPT_P = 1;
const HASH_KEYLEN = 32;

/** Produce a `scrypt$…` formatted hash for the given plaintext. */
export function hashPassword(
  plaintext: string,
  opts: { N?: number; r?: number; p?: number } = {},
): string {
  const N = opts.N ?? DEFAULT_SCRYPT_N;
  const r = opts.r ?? DEFAULT_SCRYPT_R;
  const p = opts.p ?? DEFAULT_SCRYPT_P;
  const salt = randomBytes(16);
  const hash = scryptSync(plaintext, salt, HASH_KEYLEN, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Upper bounds on scrypt cost parameters accepted during verify.
 * The users file is operator-controlled, but an accidental typo
 * ("N=21474836480") shouldn't be able to hang the auth path. The
 * caps are well above any realistic production setting. */
export const MAX_SCRYPT_N = 1 << 20;     // 1 048 576 — ~1 second on a modern core
export const MAX_SCRYPT_R = 16;
export const MAX_SCRYPT_P = 4;

/** Constant-time verify of a plaintext against a `scrypt$…` hash. */
export function verifyPassword(plaintext: string, encoded: string): boolean {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  if (N <= 0 || r <= 0 || p <= 0) return false;
  if (N > MAX_SCRYPT_N || r > MAX_SCRYPT_R || p > MAX_SCRYPT_P) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  let candidate: Buffer;
  try {
    candidate = scryptSync(plaintext, salt, expected.length, { N, r, p, maxmem: 256 * 1024 * 1024 });
  } catch {
    return false;
  }
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

/**
 * Read + parse the users file. Returns `null` (not throws) when the file
 * doesn't exist or the JSON is malformed so the caller can fall through to
 * anonymous mode cleanly.
 */
export async function readUsersFile(path: string): Promise<LocalUsersFile | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isUsersFile(parsed)) return null;
  return parsed;
}

/** Atomic write of the users file. Same tmp+rename pattern the
 *  products + token-budget snapshot writers use, so a crash mid-write
 *  leaves the previous file intact — never zero-byte. The file is
 *  the only persistent source of basic-mode credentials, so a
 *  half-write would lock every user out. */
export async function writeUsersFile(path: string, file: LocalUsersFile): Promise<void> {
  const text = JSON.stringify(file, null, 2) + "\n";
  const tmp = path + ".tmp";
  await fs.writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, path);
}

function isUsersFile(v: unknown): v is LocalUsersFile {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.users)) return false;
  return o.users.every((u) => {
    if (!u || typeof u !== "object") return false;
    const r = u as Record<string, unknown>;
    if (typeof r.username !== "string" || !r.username) return false;
    if (typeof r.name !== "string") return false;
    if (typeof r.passwordHash !== "string") return false;
    if (r.roles !== undefined && !(Array.isArray(r.roles) && r.roles.every((x) => typeof x === "string"))) return false;
    if (r.tenant !== undefined && typeof r.tenant !== "string") return false;
    return true;
  });
}

/** Find a user by username (case-sensitive) and verify the supplied password. */
export function authenticate(
  username: string,
  password: string,
  store: LocalUsersFile,
): LocalUser | null {
  const u = store.users.find((x) => x.username === username);
  if (!u) {
    // Spend roughly the same time as a real verify so a missing username
    // isn't trivially distinguishable by response timing.
    verifyPassword(password, "scrypt$32768$8$1$AAAA$AAAA");
    return null;
  }
  if (!verifyPassword(password, u.passwordHash)) return null;
  return u;
}
