// `omcp inspector-config` — emit a config JSON the official MCP
// Inspector can consume. Reads OMCP_BASE_URL (default
// http://localhost:3000) and optionally OMCP_INSPECTOR_TOKEN to put
// in the Authorization header.
//
// Pipe straight into Inspector:
//   npx @modelcontextprotocol/inspector --config <(omcp inspector-config)
//
// Or write to a file:
//   omcp inspector-config > inspector.json
//   npx @modelcontextprotocol/inspector --config inspector.json

export interface InspectorConfig {
  mcpServers: Record<string, {
    url: string;
    headers?: Record<string, string>;
  }>;
}

export function buildInspectorConfig(
  env: NodeJS.ProcessEnv = process.env,
): InspectorConfig {
  const baseRaw = env.OMCP_BASE_URL?.trim() || "http://localhost:3000";
  const base = baseRaw.replace(/\/$/, "");
  const url = `${base}/mcp`;
  const token = env.OMCP_INSPECTOR_TOKEN?.trim();
  const name = env.OMCP_INSPECTOR_SERVER_NAME?.trim() || "observability-mcp";

  const server: { url: string; headers?: Record<string, string> } = { url };
  if (token) {
    server.headers = { Authorization: `Bearer ${token}` };
  }
  return { mcpServers: { [name]: server } };
}

/** CLI entrypoint. Prints JSON to stdout; exits 0 on success. */
export function inspectorConfigCommand(): void {
  const cfg = buildInspectorConfig();
  process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
}
