#!/usr/bin/env sh
# Assembles the build context for the official plugins OCI image:
# every connectors/<name> is packed + (optionally) signed via the same
# connectors/pack.mjs the hub tarballs use, then extracted into
# <out>/plugins/<name>/ alongside the bundle Dockerfile.
#
#   connectors/build-bundle.sh <out-dir> [signing-key.pem]
#
# Identical artifacts to the per-connector hub tarballs (same pack.mjs,
# same signature) — the bundle is just a convenience packaging of them.
set -eu
OUT="${1:?usage: build-bundle.sh <out-dir> [key.pem]}"
KEY="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

rm -rf "$OUT"
mkdir -p "$OUT/plugins" "$OUT/tgz"
cp "$ROOT/connectors/Dockerfile.bundle" "$OUT/Dockerfile.bundle"

count=0
for d in "$ROOT"/connectors/*/; do
  [ -f "$d/package.json" ] || continue
  node -e "process.exit(JSON.parse(require('fs').readFileSync('$d/package.json')).observabilityMcp&&JSON.parse(require('fs').readFileSync('$d/package.json')).observabilityMcp.kind==='connector'?0:1)" || continue
  name=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$d/package.json')).observabilityMcp.name)")
  ver=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$d/manifest.json')).version)")
  if [ -n "$KEY" ]; then
    node "$ROOT/connectors/pack.mjs" "$d" --out "$OUT/tgz" --key "$KEY"
  else
    node "$ROOT/connectors/pack.mjs" "$d" --out "$OUT/tgz"
  fi
  mkdir -p "$OUT/plugins/$name"
  tar -xzf "$OUT/tgz/$name-$ver.tgz" -C "$OUT/plugins/$name"
  count=$((count + 1))
done
rm -rf "$OUT/tgz"
echo "staged $count connector(s) into $OUT/plugins"
