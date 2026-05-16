#!/usr/bin/env node
// B1 — Agent A/B experiment (docs/differentiation-plan.md).
//
// Same local model, same incident, same backends, same budget — the
// ONLY difference is the tool surface the agent is given:
//
//   Arm A  "raw"      : generic prometheus_query / loki_query only.
//                       No discovery, no anomaly detection, no health
//                       scoring, no cross-signal correlation. This is
//                       "an agent juggling raw observability APIs".
//   Arm B  "obs-mcp"  : the observability-mcp curated MCP tools
//                       (list_services, detect_anomalies,
//                       get_service_health, query_metrics/logs, ...).
//
// We measure tokens, tool-call rounds, wall-clock, and a deterministic
// correctness check. The relative delta is the thesis test — a small
// local model is fine because both arms use the SAME model.
//
// Zero npm deps. Docker-first:
//   docker run --rm --network host -v "$PWD:/w" -w /w node:20-alpine \
//     node experiments/agent-ab/run.mjs
//
// Honest caveats: see README.md. A negative result is a valid,
// reportable outcome — that is the point of running it first.

import { writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CFG = {
  ollama: process.env.OLLAMA_URL || "http://localhost:11434",
  model: process.env.OLLAMA_MODEL || "llama3.2:3b",
  mcp: process.env.MCP_URL || "http://localhost:3000/mcp",
  prom: process.env.PROM_URL || "http://localhost:9090",
  loki: process.env.LOKI_URL || "http://localhost:13100",
  chaosUrl: process.env.CHAOS_URL || "http://localhost:8081",
  maxRounds: Number(process.env.MAX_ROUNDS || 5),
  callTimeoutMs: Number(process.env.CALL_TIMEOUT_MS || 90_000),
};

const QUESTION =
  "Checkout is failing for some users. Investigate the observability data, " +
  "identify which service is the culprit and the most likely root cause, " +
  "then state it clearly. Be specific about the service name and the symptom.";

const SYSTEM =
  "You are an SRE incident-response agent. Use the available tools to gather " +
  "evidence before concluding. When you have enough evidence, give a final " +
  "answer naming the culprit service and the root-cause symptom. Do not ask " +
  "the user questions; act with the tools.";

// Ground truth for the deterministic chaos scenario (error-spike on
// payment-service → correlated cpu/latency/error-log surge).
const TRUTH = { service: "payment-service", symptom: /error|latenc|5xx|cpu|oom|memory|timeout|spike/i };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function jfetch(url, opts = {}, timeout = CFG.callTimeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    return r;
  } finally {
    clearTimeout(t);
  }
}

// ---------- Arm A: raw Prometheus/Loki primitives ----------
const RAW_TOOLS = [
  {
    type: "function",
    function: {
      name: "prometheus_query",
      description:
        "Run an instant PromQL query against Prometheus and get the current vector result.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "A PromQL expression" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "loki_query",
      description:
        "Run a LogQL query against Loki over the last 15 minutes and get matching log lines.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "A LogQL expression, e.g. {service=\"payment-service\"} |= \"error\"" } },
        required: ["query"],
      },
    },
  },
];
async function rawExec(name, args) {
  try {
    if (name === "prometheus_query") {
      const u = `${CFG.prom}/api/v1/query?query=${encodeURIComponent(args.query || "")}`;
      const r = await jfetch(u);
      return JSON.stringify(await r.json()).slice(0, 4000);
    }
    if (name === "loki_query") {
      const end = Date.now() * 1e6;
      const start = (Date.now() - 15 * 60_000) * 1e6;
      const u = `${CFG.loki}/loki/api/v1/query_range?query=${encodeURIComponent(args.query || "")}&start=${start}&end=${end}&limit=50`;
      const r = await jfetch(u);
      return JSON.stringify(await r.json()).slice(0, 4000);
    }
    return `error: unknown tool ${name}`;
  } catch (e) {
    return `error: ${String(e)}`;
  }
}

// ---------- Arm B: observability-mcp (minimal MCP-over-fetch) ----------
function parseMcp(text) {
  // Streamable HTTP may answer as SSE; extract the JSON-RPC payload.
  const m = text.match(/data:\s*(\{[\s\S]*\})\s*$/m);
  return JSON.parse(m ? m[1] : text);
}
async function mcp(method, params, sid) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sid) headers["mcp-session-id"] = sid;
  const r = await jfetch(CFG.mcp, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  return { sid: r.headers.get("mcp-session-id") || sid, json: parseMcp(await r.text()) };
}
async function mcpSetup() {
  const init = await mcp("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "agent-ab", version: "1" },
  });
  const list = await mcp("tools/list", {}, init.sid);
  const tools = (list.json.result?.tools || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.inputSchema || { type: "object", properties: {} },
    },
  }));
  return { sid: init.sid, tools };
}

// ---------- Ollama agent loop ----------
async function chat(messages, tools) {
  const r = await jfetch(`${CFG.ollama}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CFG.model,
      messages,
      tools,
      stream: false,
      options: { temperature: 0 },
    }),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}`);
  return r.json();
}

async function runArm(label, tools, exec) {
  const t0 = Date.now();
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: QUESTION },
  ];
  let tokens = 0;
  let rounds = 0;
  const toolCalls = [];
  let finalText = "";
  for (let i = 0; i < CFG.maxRounds; i++) {
    let resp;
    try {
      resp = await chat(messages, tools);
    } catch (e) {
      finalText = `__error__ ${String(e)}`;
      break;
    }
    tokens += (resp.prompt_eval_count || 0) + (resp.eval_count || 0);
    const m = resp.message || {};
    messages.push(m);
    const calls = m.tool_calls || [];
    if (calls.length === 0) {
      finalText = m.content || "";
      break;
    }
    rounds++;
    for (const c of calls) {
      const name = c.function?.name;
      const args = c.function?.arguments || {};
      toolCalls.push(name);
      let out;
      try {
        out = await exec(name, args);
      } catch (e) {
        out = `error: ${String(e)}`;
      }
      messages.push({ role: "tool", content: typeof out === "string" ? out : JSON.stringify(out) });
    }
  }
  const lc = finalText.toLowerCase();
  const culprit = lc.includes(TRUTH.service) || lc.includes("payment");
  const symptom = TRUTH.symptom.test(finalText);
  return {
    arm: label,
    tokens,
    toolRounds: rounds,
    toolCalls,
    distinctTools: [...new Set(toolCalls)],
    wallMs: Date.now() - t0,
    correct: culprit && symptom,
    culpritFound: culprit,
    symptomFound: symptom,
    finalText: finalText.slice(0, 1200),
  };
}

function table(a, b) {
  const row = (k, av, bv) => `| ${k} | ${av} | ${bv} |`;
  return [
    `| metric | A · raw Prom/Loki | B · observability-mcp |`,
    `|---|---|---|`,
    row("correct (culprit+symptom)", a.correct, b.correct),
    row("culprit identified", a.culpritFound, b.culpritFound),
    row("symptom identified", a.symptomFound, b.symptomFound),
    row("tokens (prompt+gen)", a.tokens, b.tokens),
    row("tool-call rounds", a.toolRounds, b.toolRounds),
    row("distinct tools used", a.distinctTools.length, b.distinctTools.length),
    row("wall-clock ms", a.wallMs, b.wallMs),
  ].join("\n");
}

async function main() {
  const outDir = join("experiments", "agent-ab", "results");
  mkdirSync(outDir, { recursive: true });

  // Deterministic scenario: drive chaos, let it propagate.
  try {
    await jfetch(`${CFG.chaosUrl}/chaos/error-spike`, { method: "POST" }, 8000);
    console.error("[scenario] error-spike triggered; waiting 30s for propagation");
    await sleep(30_000);
  } catch (e) {
    console.error(`[scenario] chaos trigger failed (stack not up?): ${e}`);
  }

  console.error(`[arm A] raw Prom/Loki — model ${CFG.model}`);
  const A = await runArm("raw", RAW_TOOLS, rawExec);
  console.error(`[arm A] done: correct=${A.correct} tokens=${A.tokens} rounds=${A.toolRounds}`);

  console.error(`[arm B] observability-mcp — model ${CFG.model}`);
  let B;
  try {
    const s = await mcpSetup();
    B = await runArm("obs-mcp", s.tools, async (n, a) => {
      const r = await mcp("tools/call", { name: n, arguments: a }, s.sid);
      const c = r.json.result?.content?.[0]?.text ?? JSON.stringify(r.json.result ?? r.json);
      return String(c).slice(0, 4000);
    });
  } catch (e) {
    B = { arm: "obs-mcp", error: String(e), correct: false, tokens: 0, toolRounds: 0, toolCalls: [], distinctTools: [], wallMs: 0, finalText: "" };
  }
  console.error(`[arm B] done: correct=${B.correct} tokens=${B.tokens} rounds=${B.toolRounds}`);

  try {
    await jfetch(`${CFG.chaosUrl}/chaos/reset`, { method: "POST" }, 8000);
  } catch {}

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const result = { ts, model: CFG.model, config: CFG, question: QUESTION, A, B };
  writeFileSync(join(outDir, `${ts}.json`), JSON.stringify(result, null, 2));

  const md = `# Agent A/B — latest run

Run: \`${ts}\` · model: \`${CFG.model}\` · max rounds: ${CFG.maxRounds}

${table(A, B)}

**Arm A final answer:** ${A.finalText || "(none)"}

**Arm B final answer:** ${B.finalText || B.error || "(none)"}

> Same model, same incident, same backends, same budget — only the tool
> surface differs. See \`README.md\` for methodology and caveats.
> Generated by \`experiments/agent-ab/run.mjs\`.
`;
  writeFileSync(join(outDir, "latest.md"), md);
  console.error("[done] results written to experiments/agent-ab/results/");
  console.log(table(A, B));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
