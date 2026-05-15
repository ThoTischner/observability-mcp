#!/usr/bin/env sh
# Deterministic, network-free integration test for the connector install
# flows the hub advertises. Generates an ephemeral signing key, packs a
# real connector with the SAME pack.mjs the pipeline uses, then exercises
# the actual omcp CLI:
#
#   * Air-gapped     : omcp plugin install --offline-dir --trust-root
#   * Manual / verify : omcp plugin verify --trust-root
#   * Fail-closed     : tampered tarball rejected; missing trust root refused
#
# (The "omcp online" path is the same code with a fetch instead of a
# local copy — covered against the real release URL in the per-connector
# prod check; not re-run here to keep CI offline. The Helm path is
# asserted in helm-integration.yml.)
#
# Run: sh connectors/install-it.sh   (needs node + tar; uses npx tsx)
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONN="${1:-datadog}"
W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT
cd "$ROOT"

ver=$(node -e "console.log(require('./connectors/$CONN/manifest.json').version)")

# 1. ephemeral ed25519 keypair (pub = trust root)
node -e '
const c=require("crypto"),fs=require("fs");
const {publicKey,privateKey}=c.generateKeyPairSync("ed25519");
fs.writeFileSync(process.argv[1],publicKey.export({type:"spki",format:"pem"}));
fs.writeFileSync(process.argv[2],privateKey.export({type:"pkcs8",format:"pem"}));
' "$W/pub.pem" "$W/priv.pem"

# 2. pack + sign the connector exactly like the pipeline
node connectors/pack.mjs "connectors/$CONN" --out "$W/offline" --key "$W/priv.pem"

# 3. minimal local catalog so resolveInstall has an entry
mkdir -p "$W/cat"
cat > "$W/cat/index.json" <<JSON
{"catalogVersion":1,"connectors":[{"name":"$CONN","displayName":"$CONN","description":"it","tier":"official","signalTypes":["metrics"],"latest":"$ver","versions":[{"version":"$ver","releasedAt":"2026-05-16"}]}]}
JSON

if [ -f mcp-server/dist/cli/index.js ]; then
  CLI="node mcp-server/dist/cli/index.js"
else
  CLI="npx --yes tsx mcp-server/src/cli/index.ts"
fi

echo "== air-gapped install (offline-dir + trust-root) =="
$CLI plugin install "$CONN@$ver" --from "$W/cat/index.json" \
  --offline-dir "$W/offline" --trust-root "$W/pub.pem" --dest "$W/dest"
test -f "$W/dest/$CONN/manifest.json" || { echo "FAIL: not installed"; exit 1; }
echo "PASS install"

echo "== manual verify of the installed dir =="
$CLI plugin verify "$W/dest/$CONN" --trust-root "$W/pub.pem"
echo "PASS verify"

echo "== fail-closed: tampered tarball rejected =="
mkdir -p "$W/bad"; tar -xzf "$W/offline/$CONN-$ver.tgz" -C "$W/bad"
echo '//tampered' >> "$W/bad/index.js"
tar -czf "$W/offline/$CONN-$ver.tgz" -C "$W/bad" .
if $CLI plugin install "$CONN@$ver" --from "$W/cat/index.json" \
     --offline-dir "$W/offline" --trust-root "$W/pub.pem" --dest "$W/dest" --force 2>"$W/e"; then
  echo "FAIL: tampered install succeeded"; exit 1
fi
grep -q "verification failed" "$W/e" || { echo "FAIL: wrong error"; cat "$W/e"; exit 1; }
echo "PASS tamper rejected"

echo "== fail-closed: missing trust root refused =="
if $CLI plugin install "$CONN@$ver" --from "$W/cat/index.json" \
     --offline-dir "$W/offline" --dest "$W/dest" --force 2>"$W/e2"; then
  echo "FAIL: unverified install allowed"; exit 1
fi
grep -q "verification required" "$W/e2" || { echo "FAIL: wrong error"; cat "$W/e2"; exit 1; }
echo "PASS refused without trust root"

echo "ALL CONNECTOR INSTALL FLOWS OK ($CONN@$ver)"
