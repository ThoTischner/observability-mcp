# Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Claude doesn't see the tools | Server not registered or unreachable | `claude mcp list` — re-add if missing; verify `curl http://localhost:3000/mcp` works |
| `EADDRINUSE: 3000` on start | Port already in use | `lsof -i :3000` (or `ss -tlnp \| grep 3000`); start with `PORT=8080` |
| Source connects, queries return empty | Wrong metric names for your stack | Check `resolvedSeries` in the `query_metrics` response. The default queries assume prom-client conventions; pin custom queries via source-level `metrics:` overrides ([prometheus.md](prometheus.md)) |
| Source connects, queries return zero | Wrong service-filter label | Check `resolvedLabel` in the response. Set `PROMETHEUS_SERVICE_LABELS` to put your label first |
| `list_services` returns nothing for Loki | None of the default labels are populated | Set `LOKI_SERVICE_LABELS` to include the label your shipper actually uses |
| Server starts with no sources | No `sources.yaml` and no `PROMETHEUS_URL`/`LOKI_URL` | Expected on first run — add via Web UI or env vars |
| `${VAR}` shows up literally in UI | Env var not set when server started | Set the var in shell/`.env` before launch; substitution happens at file load |
| Web UI source indicator stays red | Health check failing | Click *Test* — error message tells you what's wrong (DNS, TLS, 401, etc.) |
| Grafana Cloud auth fails | Using bearer token instead of basic | Grafana Cloud requires Basic Auth: numeric instance ID as username, API token as password ([auth-and-tls.md](auth-and-tls.md)) |
| `Invalid service name` for legitimate names | Old version | Slashes are allowed since v1.2.0 (`integrations/unix`, `kubernetes/cadvisor`); upgrade with `npx @thotischner/observability-mcp@latest` |

## Verify your setup

After starting the server:

```bash
# 1. Server health and source status
curl http://localhost:3000/api/health

# 2. MCP tools are reachable
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Then open the Web UI at `http://localhost:3000 → Sources` — every configured source should show a green indicator.
