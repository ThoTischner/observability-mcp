import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Initial config from env (overridden by API settings on each loop)
const MCP_URL = process.env.MCP_URL || "http://mcp-server:3000/mcp";
const SETTINGS_URL = MCP_URL.replace("/mcp", "/api/settings");
const INITIAL_OLLAMA_URL = process.env.OLLAMA_URL || "http://host.docker.internal:11434";
const INITIAL_MODEL = process.env.OLLAMA_MODEL || "llama3.1:8b";
const INITIAL_INTERVAL = parseInt(process.env.CHECK_INTERVAL || "30000");

const DEFAULT_SYSTEM_PROMPT = `You are an SRE agent monitoring microservices infrastructure. When observability data shows anomalies or issues:

1. Identify which service(s) are affected and what signals are abnormal
2. Determine the likely root cause based on the metric patterns and correlations
3. Assess severity: P1 (critical, user-facing outage), P2 (degraded, partial impact), P3 (warning, needs attention), P4 (informational)
4. Suggest specific, actionable remediation steps

Be concise and structured. Use the available MCP tools to gather more data if needed.`;

const MAX_TOOL_ROUNDS = 3;
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

// --- Mutable settings (refreshed from API each loop) ---
let ollamaUrl = INITIAL_OLLAMA_URL;
let ollamaModel = INITIAL_MODEL;
let checkInterval = INITIAL_INTERVAL;
let systemPrompt = DEFAULT_SYSTEM_PROMPT;
let defaultSensitivity = "medium";

function log(msg: string, data?: unknown) {
  const entry = { timestamp: new Date().toISOString(), agent: "observability-mcp-agent", msg, ...(data ? { data } : {}) };
  console.log(JSON.stringify(entry));
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Settings Sync ---
async function syncSettings(): Promise<void> {
  try {
    const res = await fetch(SETTINGS_URL);
    if (!res.ok) return;
    const s = (await res.json()) as Record<string, unknown>;
    if (s.ollamaUrl) ollamaUrl = s.ollamaUrl as string;
    if (s.ollamaModel) ollamaModel = s.ollamaModel as string;
    if (s.checkIntervalMs) checkInterval = s.checkIntervalMs as number;
    if (s.systemPrompt) systemPrompt = s.systemPrompt as string;
    if (s.defaultSensitivity) defaultSensitivity = s.defaultSensitivity as string;
  } catch {
    // Use current values if API unreachable
  }
}

// --- Incident Deduplication ---
const reportedIncidents = new Map<string, number>(); // hash → timestamp

function anomalyHash(anomaly: { service: string; metric: string; severity: string }): string {
  return `${anomaly.service}:${anomaly.metric}:${anomaly.severity}`;
}

function isDuplicate(anomaly: { service: string; metric: string; severity: string }): boolean {
  const hash = anomalyHash(anomaly);
  const lastReported = reportedIncidents.get(hash);
  if (lastReported && Date.now() - lastReported < DEDUP_TTL_MS) return true;
  return false;
}

function markReported(anomaly: { service: string; metric: string; severity: string }) {
  reportedIncidents.set(anomalyHash(anomaly), Date.now());
}

function cleanExpiredIncidents() {
  const now = Date.now();
  for (const [hash, ts] of reportedIncidents) {
    if (now - ts > DEDUP_TTL_MS) reportedIncidents.delete(hash);
  }
}

// --- MCP Connection ---
async function waitForService(url: string, name: string, maxRetries = 60): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) { log(`${name} is ready`); return; }
    } catch { /* not ready */ }
    log(`Waiting for ${name}... (${i + 1}/${maxRetries})`);
    await sleep(2000);
  }
  throw new Error(`${name} not ready after ${maxRetries} retries`);
}

async function connectMcp(): Promise<Client> {
  const client = new Client({ name: "observability-agent", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  await client.connect(transport);
  log("Connected to MCP server");
  return client;
}

// --- Ollama ---
async function ensureModel(): Promise<boolean> {
  try {
    const res = await fetch(`${ollamaUrl}/api/tags`);
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const found = data.models?.some((m) => m.name.startsWith(ollamaModel.split(":")[0]));
    if (found) { log(`Model ${ollamaModel} available`); return true; }
    log(`Pulling model ${ollamaModel}...`);
    const pullRes = await fetch(`${ollamaUrl}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: ollamaModel, stream: false }),
    });
    return pullRes.ok;
  } catch {
    return false;
  }
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

function mcpToolsToOllamaFormat(tools: McpTool[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description || "", parameters: t.inputSchema || { type: "object", properties: {} } },
  }));
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

async function chatWithOllama(
  messages: OllamaMessage[],
  tools?: ReturnType<typeof mcpToolsToOllamaFormat>
): Promise<OllamaMessage | null> {
  try {
    const body: Record<string, unknown> = { model: ollamaModel, messages, stream: false };
    if (tools && tools.length > 0) body.tools = tools;
    const res = await fetch(`${ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) { log(`Ollama error: ${res.status}`); return null; }
    return ((await res.json()) as { message: OllamaMessage }).message;
  } catch (err) {
    log(`Ollama failed: ${err}`);
    return null;
  }
}

// --- Main ---
async function main() {
  log("Starting observability-mcp agent");

  await waitForService(MCP_URL.replace("/mcp", "/api/sources"), "MCP Server");
  await syncSettings();
  log(`Config: MCP=${MCP_URL} OLLAMA=${ollamaUrl} MODEL=${ollamaModel} INTERVAL=${checkInterval}ms`);

  let client = await connectMcp();
  let { tools } = await client.listTools();
  log(`MCP tools: ${tools.map((t) => t.name).join(", ")}`);

  let ollamaAvailable = await ensureModel();

  while (true) {
    try {
      // Sync settings from API each iteration
      await syncSettings();
      cleanExpiredIncidents();

      log("--- Running anomaly scan ---");

      // Step 1: Detect anomalies
      let anomalyResult;
      try {
        anomalyResult = await client.callTool({
          name: "detect_anomalies",
          arguments: { duration: "5m", sensitivity: defaultSensitivity },
        });
      } catch (err) {
        log(`MCP call failed, reconnecting: ${err}`);
        try {
          client = await connectMcp();
          const toolsResult = await client.listTools();
          tools = toolsResult.tools;
          anomalyResult = await client.callTool({
            name: "detect_anomalies",
            arguments: { duration: "5m", sensitivity: defaultSensitivity },
          });
        } catch (reconnErr) {
          log(`Reconnection failed: ${reconnErr}`);
          await sleep(checkInterval);
          continue;
        }
      }

      const anomalyText = (anomalyResult.content as Array<{ text: string }>)[0]?.text || "{}";
      const anomalyData = JSON.parse(anomalyText);

      if (!anomalyData.anomalies || anomalyData.anomalies.length === 0) {
        log("All services healthy.");
        await sleep(checkInterval);
        continue;
      }

      // Dedup: filter out already-reported anomalies
      const newAnomalies = anomalyData.anomalies.filter(
        (a: { service: string; metric: string; severity: string }) => !isDuplicate(a)
      );

      if (newAnomalies.length === 0) {
        log(`${anomalyData.anomalies.length} anomalies detected but all previously reported (dedup).`);
        await sleep(checkInterval);
        continue;
      }

      log(`New anomalies: ${newAnomalies.length}`, {
        services: [...new Set(newAnomalies.map((a: { service: string }) => a.service))],
      });

      // Step 2: Get health for affected services
      const affectedServices = [...new Set(newAnomalies.map((a: { service: string }) => a.service))] as string[];
      const healthDetails: Record<string, unknown> = {};
      for (const svc of affectedServices) {
        try {
          const hr = await client.callTool({ name: "get_service_health", arguments: { service: svc } });
          healthDetails[svc] = JSON.parse((hr.content as Array<{ text: string }>)[0]?.text || "{}");
        } catch { /* skip */ }
      }

      // Step 3: LLM analysis with multi-turn tool calling
      const contextPrompt = `ANOMALY DETECTION REPORT:\n${JSON.stringify({ ...anomalyData, anomalies: newAnomalies }, null, 2)}\n\nSERVICE HEALTH DETAILS:\n${JSON.stringify(healthDetails, null, 2)}\n\nAnalyze these findings. What is happening, what is the severity, and what should be done?`;

      // Refresh Ollama availability (model/URL might have changed via settings)
      ollamaAvailable = await ensureModel();

      if (ollamaAvailable) {
        const ollamaTools = mcpToolsToOllamaFormat(tools);
        const messages: OllamaMessage[] = [
          { role: "system", content: systemPrompt },
          { role: "user", content: contextPrompt },
        ];

        let response = await chatWithOllama(messages, ollamaTools);

        // Multi-turn tool calling (up to MAX_TOOL_ROUNDS)
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          if (!response?.tool_calls || response.tool_calls.length === 0) break;
          messages.push(response);
          for (const tc of response.tool_calls) {
            try {
              const tr = await client.callTool({ name: tc.function.name, arguments: tc.function.arguments });
              messages.push({ role: "tool", content: (tr.content as Array<{ text: string }>)[0]?.text || "{}" });
            } catch (err) {
              messages.push({ role: "tool", content: JSON.stringify({ error: String(err) }) });
            }
          }
          response = await chatWithOllama(messages, ollamaTools);
        }

        if (response?.content) {
          console.log("\n" + "=".repeat(60));
          console.log("  INCIDENT ANALYSIS");
          console.log("=".repeat(60));
          console.log(response.content);
          console.log("=".repeat(60) + "\n");
        }
      } else {
        console.log("\n" + "=".repeat(60));
        console.log("  ANOMALY DETECTED (Ollama unavailable)");
        console.log("=".repeat(60));
        console.log(JSON.stringify({ ...anomalyData, anomalies: newAnomalies }, null, 2));
        console.log("=".repeat(60) + "\n");
      }

      // Mark all new anomalies as reported
      for (const a of newAnomalies) markReported(a);

    } catch (err) {
      log(`Detection loop error: ${err}`);
    }

    await sleep(checkInterval);
  }
}

main().catch((err) => {
  log(`Fatal error: ${err}`);
  process.exit(1);
});
