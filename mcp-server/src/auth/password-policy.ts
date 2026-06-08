/**
 * Password policy for the management-plane "basic" auth mode.
 *
 * Where this is enforced: the only point in the system that ever sees a
 * management password in plaintext is where one is *minted* — the
 * `scripts/hash-password.mjs` helper. The users file stores scrypt
 * hashes only, so password strength cannot be re-evaluated at load time
 * (there is no plaintext to check), and there is no runtime endpoint that
 * accepts a plaintext password to set. This module is therefore the
 * canonical, dependency-free policy that the minting path enforces — and
 * that any future "change my password" endpoint should call before
 * hashing. Login (`verifyPassword`) never re-checks policy: that would
 * lock out users whose passwords predate a tightened policy.
 *
 * "Basic" ruleset: a minimum length, a minimum number of character
 * classes, a small builtin common-password denylist, and a guard against
 * passwords that just echo the username. Deliberately small — this is a
 * footgun guard for self-hosted operators, not a compliance engine.
 */

export interface PasswordPolicy {
  /** Minimum length in Unicode code points. */
  minLength: number;
  /** Maximum length — a sanity bound so a megabyte "password" can't be
   *  fed into scrypt. */
  maxLength: number;
  /** How many of the four classes (lower/upper/digit/symbol) are required. */
  minClasses: number;
  /** When true, reject passwords on the builtin common-password list. */
  denylistEnabled: boolean;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 12,
  maxLength: 1024,
  minClasses: 3,
  denylistEnabled: true,
};

/**
 * A small list of the most-abused passwords + obvious app-specific ones.
 * Not exhaustive — the real defenders are length + classes. Lowercased;
 * comparison is case-insensitive.
 */
export const COMMON_PASSWORD_DENYLIST: ReadonlySet<string> = new Set([
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

export interface PasswordCheckResult {
  ok: boolean;
  /** Human-readable reasons the password was rejected; empty when ok. */
  errors: string[];
}

/**
 * Count distinct character classes present. Classification is ASCII-based:
 * a-z, A-Z, 0-9, and "everything else" (symbol). Non-ASCII letters (é, ü,
 * emoji, CJK) therefore count as the symbol class, never lower/upper. This
 * is deliberately conservative — it can only ever under-count classes, so
 * it never lets a weaker password through than the rule implies.
 */
function countClasses(pw: string): number {
  let lower = false, upper = false, digit = false, symbol = false;
  for (const ch of pw) {
    if (ch >= "a" && ch <= "z") lower = true;
    else if (ch >= "A" && ch <= "Z") upper = true;
    else if (ch >= "0" && ch <= "9") digit = true;
    else symbol = true;
  }
  return Number(lower) + Number(upper) + Number(digit) + Number(symbol);
}

/** Length in code points (so emoji / multibyte count as one). */
function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * Validate a plaintext password against the policy. `username`, when
 * given, additionally rejects passwords that are (or merely contain) the
 * username — the single most common weak choice.
 */
export function validatePassword(
  password: string,
  policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
  username?: string,
): PasswordCheckResult {
  const errors: string[] = [];
  const len = codePointLength(password);

  if (len < policy.minLength) {
    errors.push(`must be at least ${policy.minLength} characters (got ${len})`);
  }
  if (len > policy.maxLength) {
    errors.push(`must be at most ${policy.maxLength} characters`);
  }
  if (policy.minClasses > 1) {
    const classes = countClasses(password);
    if (classes < policy.minClasses) {
      errors.push(
        `must mix at least ${policy.minClasses} of: lowercase, uppercase, digit, symbol (got ${classes})`,
      );
    }
  }
  if (policy.denylistEnabled && COMMON_PASSWORD_DENYLIST.has(password.toLowerCase())) {
    errors.push("is on the common-password denylist");
  }
  if (username) {
    const u = username.toLowerCase();
    const p = password.toLowerCase();
    if (u.length >= 3 && p.includes(u)) {
      errors.push("must not contain the username");
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Resolve the policy from env, falling back to the defaults. */
export function passwordPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): PasswordPolicy {
  const num = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const truthy = (raw: string | undefined): boolean => {
    const v = raw?.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes";
  };
  return {
    minLength: num(env.OMCP_PASSWORD_MIN_LENGTH, DEFAULT_PASSWORD_POLICY.minLength),
    maxLength: DEFAULT_PASSWORD_POLICY.maxLength,
    minClasses: num(env.OMCP_PASSWORD_MIN_CLASSES, DEFAULT_PASSWORD_POLICY.minClasses),
    denylistEnabled: !truthy(env.OMCP_PASSWORD_DENYLIST_DISABLED),
  };
}

/** True when the policy is turned off entirely via env. */
export function passwordPolicyDisabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.OMCP_PASSWORD_POLICY_DISABLED?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
