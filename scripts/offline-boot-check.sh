#!/usr/bin/env bash
# Verifiable offline mode: start the image on an internal (no-internet) Docker
# network with zero sources configured, then assert /healthz and /readyz from
# a sibling container on the same isolated network. Exits non-zero on any
# failure. This is the end-to-end proof of the "no data egress / air-gapped"
# guarantee (the static guard lives in src/net/egress-policy.test.ts).
set -euo pipefail

IMG="${IMG:-observability-mcp:offline-check}"
NET="omcp-offline-$$"
SRV="omcp-offline-srv-$$"

cleanup() {
  docker rm -f "$SRV" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> building image ($IMG)"
docker build -t "$IMG" ./mcp-server

echo "==> creating INTERNAL network (no internet egress): $NET"
docker network create --internal "$NET" >/dev/null

echo "==> starting server with NO sources, no internet"
docker run -d --name "$SRV" --network "$NET" \
  -e PROMETHEUS_URL= -e LOKI_URL= \
  "$IMG" >/dev/null

echo "==> probing /healthz and /readyz from an isolated sibling"
ok=0
for i in $(seq 1 30); do
  if docker run --rm --network "$NET" curlimages/curl:8.10.1 \
       -fsS "http://$SRV:3000/healthz" >/dev/null 2>&1; then
    ok=1; break
  fi
  sleep 2
done

if [ "$ok" -ne 1 ]; then
  echo "FAIL: server did not become healthy offline"
  docker logs "$SRV" || true
  exit 1
fi

docker run --rm --network "$NET" curlimages/curl:8.10.1 \
  -fsS "http://$SRV:3000/readyz" >/dev/null

echo "PASS: server boots and serves health fully offline, zero sources, no egress"
