// Inspect observe-path E2E (live).
//
// Proves the full chain: a real tools/call over the Streamable HTTP transport
// is captured by the observe recorder and surfaces on /api/inspect/events +
// /api/inspect/flows. Runs against a booted gateway via OMCP_CONFORMANCE_URL
// (the same env the spec-conformance harness uses); skips entirely when unset
// so a plain unit-test run stays hermetic.
//
//   OMCP_CONFORMANCE_URL=http://localhost:3000/mcp \
//   npx tsx --test src/conformance/inspect-e2e.test.ts
//
// integration.yml runs this after booting the demo stack.

import { test } from "node:test";
import assert from "node:assert/strict";

const URL_ENV = process.env.OMCP_CONFORMANCE_URL;
const skip = !URL_ENV;
const opts = skip ? { skip: "OMCP_CONFORMANCE_URL not set" } : {};
const base = (URL_ENV ?? "").replace(/\/mcp\/?$/, "");

async function rpc(method: string, params: unknown, session?: string): Promise<{ text: string; session?: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (session) headers["mcp-session-id"] = session;
  const res = await fetch(URL_ENV!, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { text: await res.text(), session: res.headers.get("mcp-session-id") ?? session };
}

test("observe: a real tools/call surfaces on /api/inspect/events and /flows", opts, async () => {
  // 1. Handshake — open an MCP session.
  const init = await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "inspect-e2e", version: "0" },
  });
  const session = init.session;
  assert.ok(session, "server returned a session id");
  await fetch(URL_ENV!, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": session! },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
  });

  // 2. Make an observable tool call. list_sources is always registered and
  //    needs no backend data, so it's a stable probe.
  await rpc("tools/call", { name: "list_sources", arguments: {} }, session);

  // 3. The observe recorder is synchronous on the post-invoke hook, but give
  //    the event loop a tick before reading back.
  await new Promise((r) => setTimeout(r, 250));

  // 4. /api/inspect/events shows the call.
  const evRes = await fetch(`${base}/api/inspect/events?tool=list_sources&limit=50`);
  assert.equal(evRes.status, 200, "events endpoint reachable");
  const ev = (await evRes.json()) as { events: Array<{ tool: string; decision: string; outcome: string }>; mode: string };
  assert.ok(["observe", "dryrun", "enforce"].includes(ev.mode), `recording mode active (got ${ev.mode})`);
  assert.ok(
    ev.events.some((e) => e.tool === "list_sources" && e.decision === "allow"),
    "list_sources call was observed",
  );

  // 5. /api/inspect/flows includes the tool node + an edge into it.
  const flRes = await fetch(`${base}/api/inspect/flows?window=1h`);
  assert.equal(flRes.status, 200, "flows endpoint reachable");
  const fl = (await flRes.json()) as { nodes: Array<{ id: string }>; edges: Array<{ to: string }>; total: number };
  assert.ok(fl.total >= 1, "flow graph has traffic");
  assert.ok(fl.nodes.some((n) => n.id === "tool:list_sources"), "tool node present in the flow graph");
});

test("/api/inspect/mode reports a recording mode", opts, async () => {
  const res = await fetch(`${base}/api/inspect/mode`);
  assert.equal(res.status, 200);
  const m = (await res.json()) as { mode: string; recording: boolean };
  assert.ok(["off", "observe", "dryrun", "enforce"].includes(m.mode));
});

test("enforce: an out-of-profile tool call is blocked end-to-end", opts, async () => {
  // CSRF double-submit: grab the issued token, echo it on every mutation.
  const probe = await fetch(`${base}/api/inspect/mode`);
  const sc = probe.headers.get("set-cookie") || "";
  const tok = (sc.match(/omcp-csrf=([^;]+)/) || [])[1];
  const csrf: Record<string, string> = tok ? { "x-csrf-token": decodeURIComponent(tok), cookie: `omcp-csrf=${tok}` } : {};
  const write = (path: string, method: string, body: unknown) =>
    fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...csrf }, body: JSON.stringify(body) });

  // MCP session + an observed list_sources call (gives us a rule to accept).
  const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "inspect-e2e", version: "0" } });
  const session = init.session!;
  await fetch(URL_ENV!, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": session }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) });
  await rpc("tools/call", { name: "list_sources", arguments: {} }, session);
  await new Promise((r) => setTimeout(r, 250));

  try {
    // Learn, then accept ONLY the list_sources rule — so list_sources is
    // allow-listed but every other tool deviates, regardless of demo traffic.
    await write("/api/inspect/profile/derive?window=24h", "POST", {});
    const prof = (await (await fetch(`${base}/api/inspect/profile`)).json()) as { rules: Array<{ id: string; tool: string; status: string }> };
    const lsRule = prof.rules.find((r) => r.tool === "list_sources");
    assert.ok(lsRule, "a list_sources rule was derived");
    const acc = await write(`/api/inspect/profile/rules/${encodeURIComponent(lsRule!.id)}`, "PATCH", { status: "accepted" });
    assert.equal(acc.status, 200, "rule accepted (CSRF + inspection:write OK)");

    // Switch to enforce.
    const setRes = await write("/api/inspect/mode", "PUT", { mode: "enforce" });
    assert.equal(setRes.status, 200, "mode set to enforce");

    // list_sources is within the accepted rule → NOT blocked.
    const okCall = await rpc("tools/call", { name: "list_sources", arguments: {} }, session);
    assert.doesNotMatch(okCall.text, /Blocked by the inspection profile/, "accepted tool allowed under enforce");

    // list_services has no accepted rule → blocked by the enforcer.
    const blocked = await rpc("tools/call", { name: "list_services", arguments: {} }, session);
    assert.match(blocked.text, /Blocked by the inspection profile/, "out-of-profile tool blocked under enforce");

    // The block is recorded as a deviation.
    await new Promise((r) => setTimeout(r, 200));
    const devs = (await (await fetch(`${base}/api/inspect/deviations?window=1h`)).json()) as { deviations: Array<{ tool: string; decision: string }> };
    assert.ok(devs.deviations.some((d) => d.tool === "list_services" && d.decision === "blocked"), "blocked deviation recorded");
  } finally {
    // ALWAYS restore observe so we never leave the shared demo server enforcing.
    await write("/api/inspect/mode", "PUT", { mode: "observe" }).catch(() => {});
  }
});
