# Agent (Ollama integration)

The **agent** is a separate process that uses an LLM via Ollama to detect anomalies and produce incident analyses. The MCP server itself is LLM-agnostic — it just provides tools and data. You can use the MCP server with Claude Code, GPT-4, or anything else and skip the agent entirely.

## When to run the agent

- You want autonomous detection: agent polls services, runs `detect_anomalies`, and writes incident reports.
- You want an entirely local workflow: Ollama on your machine, no external API.
- You're running the demo Compose stack and want the chaos demonstrations to produce LLM analyses.

If you're driving everything from Claude Code on demand, you don't need the agent.

## Setup

Ollama must be reachable from wherever the agent runs. In WSL2 the Ollama daemon typically runs on the Windows host:

```bash
# On the Windows host
ollama serve
ollama pull llama3.1:8b
```

In docker-compose (this repo) the agent already points at `host.docker.internal:11434`.

## Configuration

The agent is configured through environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_URL` | `http://host.docker.internal:11434` | Ollama API endpoint |
| `OLLAMA_MODEL` | `llama3.1:8b` | Model used for incident analysis |
| `SYSTEM_PROMPT` | *(built-in SRE prompt)* | Custom instructions for the LLM |
| `CHECK_INTERVAL` | `30000` | Detection loop interval in ms |

If Ollama is unavailable, the agent falls back to raw anomaly JSON output without LLM analysis.

## Loop behavior

1. Sync settings from the MCP server (`checkIntervalMs`, `defaultSensitivity`).
2. Call `list_services` to discover what to monitor.
3. Call `detect_anomalies` per service with the configured sensitivity.
4. For each anomaly: ask the LLM to root-cause it, with up to three rounds of tool calls (`query_metrics`, `query_logs`, `get_service_health`).
5. Output the incident analysis with severity classification (P1–P4).
6. Deduplicate within a 5-minute TTL so the same incident isn't reported repeatedly.
