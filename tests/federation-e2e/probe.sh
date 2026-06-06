#!/usr/bin/env bash
# Federation E2E probe: hit gateway-b's MCP endpoint, assert that
# tools/list returns at least one tool with the upstream-a namespace
# prefix, then call one and assert the response is well-formed.
#
# Both gateways must already be up (the workflow runs `docker compose
# up --wait` before this script).

set -uo pipefail

B="${B_BASE:-http://localhost:13002}"

echo "=== Probing federation against ${B}/mcp ==="

# Initialise a session so we can include the mcp-session-id header
# on subsequent requests.
init=$(curl -sS -i -X POST "${B}/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"fed-e2e","version":"0"}}}')
session=$(printf '%s\n' "$init" | awk 'tolower($1)=="mcp-session-id:" {print $2}' | tr -d '\r\n')
if [ -z "$session" ]; then
  echo "FAIL: gateway-b did not return a session id from initialize" >&2
  printf '%s\n' "$init" | head -40
  exit 1
fi
echo "ok: session ${session}"

# tools/list — federation should add a "a."-namespaced tool entry.
tools=$(curl -sS -X POST "${B}/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $session" \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
echo "${tools}" | head -c 1200
echo

if ! echo "$tools" | grep -qE '"name"[[:space:]]*:[[:space:]]*"a\.'; then
  echo "FAIL: gateway-b tools/list did not include any a.-namespaced upstream tool" >&2
  exit 1
fi
echo "ok: at least one a.-namespaced tool appears in tools/list"

# Pick a known-safe namespaced tool to call: list_services has the
# smallest blast radius (read-only, no required args, works against
# an empty sources config).
call=$(curl -sS -X POST "${B}/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $session" \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"a.list_sources","arguments":{}}}')
echo "${call}" | head -c 800
echo

# We don't assert any specific payload — only that the call dispatched
# successfully (no JSON-RPC error envelope at the top level).
if echo "$call" | grep -q '"error"[[:space:]]*:[[:space:]]*{'; then
  echo "FAIL: gateway-b returned JSON-RPC error envelope on tools/call" >&2
  exit 1
fi
if echo "$call" | grep -q '"isError"[[:space:]]*:[[:space:]]*true'; then
  echo "FAIL: gateway-b tools/call returned isError:true (federation dispatch crashed)" >&2
  exit 1
fi
echo "ok: a.list_sources dispatched cleanly through federation"

echo "=== federation E2E probe PASS ==="
