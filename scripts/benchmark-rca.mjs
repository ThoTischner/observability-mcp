#!/usr/bin/env node
// Controlled A/B benchmark: does giving the LLM access to topology tools
// (get_topology + get_blast_radius) reduce token spend and improve
// correctness on a basic root-cause-analysis prompt?
//
// Methodology
// -----------
// For each iteration:
//   1. POST /chaos/reset                       — clear prior state
//   2. POST /chaos/error-spike on payment-service
//   3. Wait CHAOS_WINDOW_MS so the anomaly is visible to MCP
//   4. Send a fixed RCA prompt to Ollama with the MCP tool surface:
//        --mode=baseline  → 6 tools (no topology)
//        --mode=topology  → 8 tools (incl. get_topology, get_blast_radius)
//   5. Multi-turn tool calling: up to MAX_ROUNDS rounds, each tool call
//      goes through MCP /mcp Streamable HTTP, results are fed back.
//   6. When the LLM produces a final answer (no tool_calls), score:
//        - correctness: did the final answer name "payment-service"
//          AND mention an error-rate / 5xx / error-spike signal?
//        - tokens: sum of prompt_eval_count + eval_count across every
//          Ollama call in the conversation.
//
// We measure TOTAL tokens across the whole conversation, not just the
// final turn — that captures the per-round context growth honestly. Some
// tool results are large; if topology shrinks how many other tools the
// agent has to call, that shows up here.
//
// Correctness scoring is intentionally crude (substring match). LLM
// judges add another model dependency we'd have to defend; for a public
// number we'd rather over-disclose the rule than hide it behind a
// rubric. See docs/benchmark-astronomy-shop.md.

import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// When this file is imported (e.g. by the unit test), skip the IIFE so
// the pure helpers can be exercised without spinning up MCP / Ollama.
const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

const args = parseArgs(process.argv.slice(2));
const MODE = args.mode || "baseline";
const ITERATIONS = +(args.iterations || 3);
const MCP_URL = args.mcp || "http://localhost:3000/mcp";
const OLLAMA_URL = args.ollama || "http://localhost:11434";
const MODEL = args.model || "llama3.1:8b";
const CHAOS_BASE = args.chaos || "http://localhost:8081";
const CHAOS_TARGET_SERVICE = args.target || "payment-service";
const CHAOS_WINDOW_MS = +(args.window || 45_000);
const MAX_ROUNDS = +(args.rounds || 3);
const TOPOLOGY_TOOLS = new Set(["get_topology", "get_blast_radius"]);

// Two chaos drivers are supported so the same harness covers both
// demos:
//   - "chaos"        → our own /chaos/error-spike endpoints on the
//     bundled k3s demo workload (default).
//   - "feature-flag" → POST to flagd's HTTP API to toggle an Astronomy
//     Shop failure flag (e.g. paymentServiceFailure). Targets in this
//     mode are flag names, not service names.
const CHAOS_DRIVER = args["chaos-driver"] || "chaos";
const FLAG_NAME = args.flag || "paymentServiceFailure";
const FLAG_VARIANT = args["flag-variant"] || "on";
const FLAGD_URL = args.flagd || "http://localhost:8013";

const RCA_PROMPT = args.prompt || `Customers are reporting that checkout is failing intermittently.
Identify the single underlying root-cause service (NOT the symptom
service) and the failing signal in two sentences. Use the available
tools.`;

// Optional: override scoring rule. Pass `--correct-substrings=a,b,c`
// and an answer must contain ALL of (a,b,c) — substring match,
// case-insensitive, dashes/underscores/spaces are interchangeable
// (same normalization the default scorer uses). When omitted, the
// default {target,signal} rule applies.
const CORRECT_SUBSTRINGS = args["correct-substrings"]
  ? args["correct-substrings"].split(",").map((s) => s.trim()).filter(Boolean)
  : null;
const SKIP_CHAOS = args["skip-chaos"] === "true";

if (!["baseline", "topology"].includes(MODE)) {
  die(`--mode must be "baseline" or "topology" (got ${MODE})`);
}

// Module-level state used by the MCP helpers below. Declared up here so
// the top-level await IIFE can call into them without tripping TDZ.
let _sessionId = null;

if (IS_MAIN) (async () => {
  const tools = await mcpToolsList();
  const filtered = MODE === "topology" ? tools : tools.filter((t) => !TOPOLOGY_TOOLS.has(t.name));
  log(`mode=${MODE} model=${MODEL} iterations=${ITERATIONS} tools=${filtered.length} (${filtered.map((t) => t.name).join(",")})`);

  const results = [];
  for (let i = 1; i <= ITERATIONS; i++) {
    log(`--- iteration ${i}/${ITERATIONS} ---`);
    if (!SKIP_CHAOS) {
      await chaosReset();
      await chaosTrigger("error-spike");
      log(`waiting ${CHAOS_WINDOW_MS}ms for anomaly to manifest...`);
      await sleep(CHAOS_WINDOW_MS);
    }
    const r = await runOne(filtered);
    log(`  tokens=${r.tokens} rounds=${r.rounds} correct=${r.correct} duration=${r.durationMs}ms`);
    results.push(r);
    await chaosReset();
  }

  const totalTokens = results.reduce((s, r) => s + r.tokens, 0);
  const correct = results.filter((r) => r.correct).length;
  const avgRounds = results.reduce((s, r) => s + r.rounds, 0) / results.length;
  const avgDuration = results.reduce((s, r) => s + r.durationMs, 0) / results.length;
  const out = {
    mode: MODE,
    model: MODEL,
    iterations: ITERATIONS,
    tools: filtered.map((t) => t.name),
    totals: {
      tokens: totalTokens,
      meanTokensPerIteration: Math.round(totalTokens / results.length),
      correctIterations: correct,
      accuracy: correct / results.length,
      meanRounds: +avgRounds.toFixed(2),
      meanDurationMs: Math.round(avgDuration),
    },
    iterations_detail: results,
  };
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => die(e.stack || String(e)));

async function runOne(toolDefs) {
  const ollamaTools = toolDefs.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.inputSchema || { type: "object", properties: {} },
    },
  }));
  const toolNames = toolDefs.map((t) => t.name).join(", ");
  const messages = [
    {
      role: "system",
      content:
        "You are an SRE diagnosing a live production incident. " +
        "You MUST gather evidence by invoking the diagnostic tools through the function-calling API. " +
        "Do NOT describe in text what tool you would call — actually invoke it. " +
        "If you write tool calls as text/JSON in your message content instead of using the tool-call mechanism, the call is wasted. " +
        `Tools available: ${toolNames}. ` +
        "Workflow: call detect_anomalies first to see what's abnormal, then use targeted tools (query_metrics, query_logs, get_service_health) to confirm before answering.",
    },
    { role: "user", content: RCA_PROMPT },
  ];
  const started = Date.now();
  let totalTokens = 0;
  let rounds = 0;
  let finalContent = "";
  for (let r = 0; r < MAX_ROUNDS + 1; r++) {
    const resp = await ollamaChat(messages, ollamaTools);
    if (!resp) break;
    totalTokens += (resp.prompt_eval_count || 0) + (resp.eval_count || 0);
    const msg = resp.message || {};
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      finalContent = String(msg.content || "");
      break;
    }
    rounds += 1;
    messages.push(msg);
    for (const tc of msg.tool_calls) {
      const name = tc.function?.name;
      const argObj = tc.function?.arguments || {};
      let content;
      try {
        const tr = await mcpToolCall(name, argObj);
        content = (tr.content?.[0]?.text) || JSON.stringify(tr);
      } catch (e) {
        content = JSON.stringify({ error: String(e) });
      }
      messages.push({ role: "tool", content, tool_name: name });
    }
    if (r === MAX_ROUNDS - 1) {
      // Final round must produce an answer, not more tools.
      ollamaTools.length = 0;
    }
  }
  return {
    tokens: totalTokens,
    rounds,
    correct: scoreCorrectness(finalContent),
    durationMs: Date.now() - started,
    finalAnswer: finalContent.slice(0, 600),
  };
}

function scoreCorrectness(text) {
  // Normalize both sides so "Payment Service", "payment_service",
  // "payment-service" all count as naming the same target. Substring
  // matching is intentionally simple-minded — see the methodology doc.
  const norm = (s) => (s || "").toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
  const t = norm(text);
  // If the operator supplied a custom substring list, ALL of them
  // must appear (normalized) in the answer. Used by the blast-radius
  // scenario where the right answer is a *set* of services.
  if (CORRECT_SUBSTRINGS) {
    return CORRECT_SUBSTRINGS.every((s) => t.includes(norm(s)));
  }
  const namedTarget = t.includes(norm(CHAOS_TARGET_SERVICE));
  // Underscore-form ("error_rate") is normalized to "error rate" via
  // the same map above, so the signal regex sees it as the
  // word-bounded "error rate".
  const namedSignal = /(error[ -]?spike|error rate|5xx|errors?\b|http 5)/i.test(t);
  return namedTarget && namedSignal;
}

async function ollamaChat(messages, tools) {
  // temperature=0 makes the model deterministic — important so the
  // benchmark is reproducible across runs of the same arm. options.
  // num_ctx large enough for tool defs + multi-round transcripts.
  const body = {
    model: MODEL,
    messages,
    stream: false,
    options: { temperature: 0, num_ctx: 8192 },
  };
  if (tools.length > 0) body.tools = tools;
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    log(`ollama unreachable at ${OLLAMA_URL}: ${e.message || e}`);
    return null;
  }
  if (!res.ok) {
    log(`ollama error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  return res.json();
}

// --- MCP Streamable HTTP — session-per-iteration --------------------------

async function mcpEnsureSession() {
  if (_sessionId) return _sessionId;
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "benchmark-rca", version: "0.1.0" },
      },
    }),
  });
  _sessionId = res.headers.get("mcp-session-id");
  await res.text();
  if (!_sessionId) die("MCP initialize returned no session id");
  await fetch(MCP_URL, {
    method: "POST",
    headers: mcpHeaders(),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
  });
  return _sessionId;
}

function mcpHeaders() {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "mcp-session-id": _sessionId,
  };
}

async function mcpToolsList() {
  await mcpEnsureSession();
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: mcpHeaders(),
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const body = await res.text();
  return parseSseJson(body)?.result?.tools || [];
}

async function mcpToolCall(name, argObj) {
  await mcpEnsureSession();
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: mcpHeaders(),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1e9),
      method: "tools/call",
      params: { name, arguments: argObj },
    }),
  });
  const body = await res.text();
  const parsed = parseSseJson(body);
  if (parsed?.error) throw new Error(`MCP error: ${parsed.error.message}`);
  return parsed?.result || {};
}

function parseSseJson(raw) {
  // MCP Streamable HTTP responses arrive either as plain JSON or as a
  // single SSE event prefixed `data: `. Handle both forms.
  const text = String(raw || "").trim();
  if (!text) return null;
  for (const line of text.split(/\r?\n/)) {
    const s = line.startsWith("data: ") ? line.slice(6) : line;
    try { return JSON.parse(s); } catch { /* try next */ }
  }
  return null;
}

// --- Chaos helpers --------------------------------------------------------
//
// Two drivers, same shape: reset() clears prior state, trigger() induces
// the failure. The harness loop calls each per iteration so the LLM sees
// a fresh anomaly window each time.

async function chaosReset() {
  if (CHAOS_DRIVER === "feature-flag") return flagSet(FLAG_NAME, "off");
  try { await fetch(`${CHAOS_BASE}/chaos/reset`, { method: "POST" }); }
  catch { /* tolerate */ }
}
async function chaosTrigger(name) {
  if (CHAOS_DRIVER === "feature-flag") return flagSet(FLAG_NAME, FLAG_VARIANT);
  const res = await fetch(`${CHAOS_BASE}/chaos/${name}`, { method: "POST" });
  if (!res.ok) die(`chaos trigger ${name} failed: HTTP ${res.status}`);
}

// flagd OFREP HTTP API. Astronomy Shop's flagd is configured via a JSON
// document loaded from disk; toggling at runtime is done by overwriting
// the document and triggering reload, OR via flagd-ui's REST proxy. The
// upstream demo exposes flagd-ui on :8080/feature backed by an
// implementation-specific PUT endpoint — we drive it via the simpler
// flagd direct API at FLAGD_URL.
//
// We use the OFREP /ofrep/v1/configuration/flags/{name}/variant
// management endpoint when available; fall back to a no-op with a
// warning so a missing flagd doesn't crash the harness — the user can
// run with --chaos-driver=feature-flag --flagd=<url> once they wire it.
async function flagSet(name, variant) {
  try {
    const res = await fetch(`${FLAGD_URL}/flags/${encodeURIComponent(name)}/variant`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variant }),
    });
    if (!res.ok && res.status !== 404) {
      log(`flagd set ${name}=${variant} returned HTTP ${res.status} — continuing`);
    }
  } catch (e) {
    log(`flagd unreachable at ${FLAGD_URL}: ${e.message || e} — continuing`);
  }
}

// --- utilities ------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const [k, ...rest] = a.slice(2).split("=");
    out[k] = rest.length ? rest.join("=") : "true";
  }
  return out;
}
function log(...m) { console.error(...m); }
function die(m) { console.error(m); process.exit(1); }

export { parseArgs, parseSseJson, scoreCorrectness };
