// Entitlement token minting CLI (FSL-1.1-Apache-2.0).
//
// The issuer-side companion to verifyEntitlement: turns an Ed25519
// private key + a few flags into a signed token a deployment can pin via
// OMCP_ENTITLEMENT_TOKEN. Dependency-free (node:crypto + this package).
//
//   node enterprise/entitlement/mint.mjs \
//     --key ./issuer-ed25519.pem \
//     --sub org-acme --tier enterprise \
//     --features access-control,audit --ttl 365d
//
// Key generation (no extra tooling — OpenSSL):
//   openssl genpkey -algorithm ed25519        -out issuer-ed25519.pem
//   openssl pkey -in issuer-ed25519.pem -pubout -out issuer-ed25519.pub
//
// `--ttl` accepts <n>[s|m|h|d] (default 365d). The pure helpers are
// exported so the test suite drives them without spawning a process.

import { readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { signEntitlement } from "./entitlement.mjs";

export function parseTtlSeconds(ttl) {
  const m = String(ttl).match(/^(\d+)([smhd])$/);
  if (!m) throw new Error(`invalid --ttl '${ttl}' (use <n>s|m|h|d, e.g. 365d)`);
  const n = parseInt(m[1], 10);
  return n * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
}

export function parseArgs(argv) {
  const out = { sub: undefined, tier: "enterprise", features: [], ttl: "365d", key: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sub") out.sub = argv[++i];
    else if (a === "--tier") out.tier = argv[++i];
    else if (a === "--features") out.features = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--ttl") out.ttl = argv[++i];
    else if (a === "--key") out.key = argv[++i];
    else throw new Error(`unknown argument '${a}'`);
  }
  return out;
}

/** Pure: build the signed token from already-parsed inputs. */
export function mint({ sub, tier, features, ttlSeconds, privateKey }, now = Math.floor(Date.now() / 1000)) {
  if (!sub) throw new Error("--sub is required");
  if (!Array.isArray(features) || features.length === 0) {
    throw new Error("--features is required (comma-separated, e.g. access-control,audit)");
  }
  const payload = { sub, tier: tier || "enterprise", features, iat: now, exp: now + ttlSeconds };
  return signEntitlement(payload, privateKey);
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
    if (!args.key) throw new Error("--key <path to Ed25519 private key PEM> is required");
    const privateKey = createPrivateKey(readFileSync(args.key, "utf8"));
    const token = mint({
      sub: args.sub,
      tier: args.tier,
      features: args.features,
      ttlSeconds: parseTtlSeconds(args.ttl),
      privateKey,
    });
    process.stdout.write(token + "\n");
  } catch (e) {
    process.stderr.write(`mint: ${e.message}\n`);
    process.stderr.write(
      "usage: mint.mjs --key <priv.pem> --sub <id> [--tier <t>] --features <a,b> [--ttl <365d>]\n"
    );
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
