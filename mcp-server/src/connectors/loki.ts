import { Agent } from "node:https";
import type { ObservabilityConnector } from "./interface.js";
import type {
  SourceConfig,
  SourceAuth,
  ConnectorHealth,
  ServiceInfo,
  MetricDefinition,
  LogQuery,
  LogResult,
  LogEntry,
  SignalType,
} from "../types.js";
import { buildTlsAgent } from "./tls.js";

const DEFAULT_SERVICE_LABELS = ["service_name", "service", "job", "app", "container"];
const LABEL_CACHE_TTL_MS = 60_000;

export class LokiConnector implements ObservabilityConnector {
  readonly type = "loki";
  readonly signalType: SignalType = "logs";
  name = "";
  private baseUrl = "";
  private auth?: SourceAuth;
  private tlsAgent?: Agent;
  private serviceLabels: string[] = DEFAULT_SERVICE_LABELS;
  private labelValuesCache = new Map<string, { values: string[]; expiresAt: number }>();

  async connect(config: SourceConfig): Promise<void> {
    this.name = config.name;
    this.baseUrl = config.url.replace(/\/$/, "");
    this.auth = config.auth;
    this.tlsAgent = buildTlsAgent(config);
    const envLabels = process.env.LOKI_SERVICE_LABELS;
    if (envLabels) {
      this.serviceLabels = envLabels.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  getDefaultMetrics(): MetricDefinition[] {
    // Loki is a log backend — no metric definitions by default
    return [];
  }

  getMetrics(): MetricDefinition[] {
    return [];
  }

  private fetchOptions(): RequestInit {
    const opts: RequestInit = { headers: this.buildAuthHeaders() };
    if (this.tlsAgent) {
      // @ts-expect-error Node.js extension for native fetch
      opts.dispatcher = this.tlsAgent;
    }
    return opts;
  }

  async healthCheck(): Promise<ConnectorHealth> {
    const start = Date.now();
    try {
      // Use the labels query API instead of /ready: managed Loki (Grafana
      // Cloud, etc.) does not expose the operational health endpoint.
      // /loki/api/v1/labels returns 200 with auth on any reachable Loki.
      const res = await fetch(
        `${this.baseUrl}/loki/api/v1/labels`,
        this.fetchOptions()
      );
      return {
        status: res.ok ? "up" : "down",
        latencyMs: Date.now() - start,
        message: res.ok ? "Loki is ready" : `HTTP ${res.status}`,
      };
    } catch (err) {
      return { status: "down", latencyMs: Date.now() - start, message: String(err) };
    }
  }

  async disconnect(): Promise<void> {}

  async listServices(): Promise<ServiceInfo[]> {
    // Probe each candidate label and merge values. Loki streams may identify
    // services via service_name, service, job, app, or container depending on
    // the shipper configuration. Walking all candidates ensures historical
    // streams remain reachable when label conventions change over time.
    const seen = new Map<string, ServiceInfo>();
    for (const label of this.serviceLabels) {
      const values = await this.getLabelValues(label);
      for (const raw of values) {
        // Docker's loki.source.docker writes container names with a leading '/'
        // (Docker API Names[0] convention). Strip it for display so the name
        // matches what the service-name validator and users will pass back in.
        const display = label === "container" ? raw.replace(/^\//, "") : raw;
        if (!seen.has(display)) {
          seen.set(display, {
            name: display,
            source: this.name,
            signalType: "logs" as const,
            labels: { discoveredVia: label },
          });
        }
      }
    }
    return Array.from(seen.values());
  }

  async queryLogs(params: LogQuery): Promise<LogResult> {
    const { start, end } = this.parseTimeRange(params.duration);
    const limit = Math.min(Math.max(params.limit || 100, 1), 1000);

    // Resolve label + actual selector value. For the 'container' label the
    // value stored in Loki may be '/my-app-1' while the caller passes the
    // sanitized 'my-app-1' — return the prefixed form so the LogQL selector
    // matches the real stream.
    const { label: matchedLabel, value: rawValue } = await this.resolveServiceSelector(params.service);
    const service = this.escapeLogQLValue(rawValue);
    let logql = `{${matchedLabel}="${service}"}`;
    if (params.level) {
      const level = this.escapeLogQLValue(params.level);
      logql += ` | json | level="${level}"`;
    } else {
      logql += ` | json`;
    }
    if (params.query) {
      const query = this.escapeLogQLRegex(params.query);
      logql += ` |~ \`${query}\``;
    }

    const url =
      `/loki/api/v1/query_range?query=${encodeURIComponent(logql)}` +
      `&start=${start}000000000&end=${end}000000000&limit=${limit}`;

    const data = await this.apiGet<LokiQueryResponse>(url);

    const entries: LogEntry[] = [];
    for (const stream of data?.data?.result || []) {
      const labels = stream.stream;
      for (const [ts, line] of stream.values) {
        const parsed = this.parseLine(line);
        entries.push({
          timestamp: new Date(parseInt(ts) / 1_000_000).toISOString(),
          level: parsed.level || labels.level || "unknown",
          message: parsed.msg || line,
          labels,
        });
      }
    }

    // Sort newest first
    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    // Compute summary
    const errorCount = entries.filter((e) => e.level === "error").length;
    const warnCount = entries.filter((e) => e.level === "warn").length;
    const topPatterns = this.extractTopPatterns(entries.filter((e) => e.level === "error"));

    return {
      source: this.name,
      service: params.service,
      entries,
      summary: {
        total: entries.length,
        errorCount,
        warnCount,
        topPatterns,
      },
    };
  }

  // --- Private helpers ---

  private async getLabelValues(label: string): Promise<string[]> {
    const cached = this.labelValuesCache.get(label);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.values;
    }
    try {
      const data = await this.apiGet<{ data: string[] }>(
        `/loki/api/v1/label/${encodeURIComponent(label)}/values`
      );
      const values = data?.data || [];
      this.labelValuesCache.set(label, {
        values,
        expiresAt: Date.now() + LABEL_CACHE_TTL_MS,
      });
      return values;
    } catch {
      this.labelValuesCache.set(label, { values: [], expiresAt: Date.now() + LABEL_CACHE_TTL_MS });
      return [];
    }
  }

  private async resolveServiceSelector(service: string): Promise<{ label: string; value: string }> {
    for (const label of this.serviceLabels) {
      const values = await this.getLabelValues(label);
      if (values.includes(service)) return { label, value: service };
      // Container label values are Docker-prefixed with '/'. The caller can't
      // pass that form (validator rejects '/'), so probe the prefixed variant.
      if (label === "container" && values.includes(`/${service}`)) {
        return { label, value: `/${service}` };
      }
    }
    return { label: this.serviceLabels[0] || "service_name", value: service };
  }

  private parseLine(line: string): Record<string, string> {
    try {
      return JSON.parse(line);
    } catch {
      return { msg: line };
    }
  }

  private extractTopPatterns(errorEntries: LogEntry[]): string[] {
    const patterns = new Map<string, number>();
    for (const entry of errorEntries) {
      // Use first 100 chars of message as pattern key
      const key = entry.message.slice(0, 100);
      patterns.set(key, (patterns.get(key) || 0) + 1);
    }
    return Array.from(patterns.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([pattern, count]) => `${pattern} (${count}x)`);
  }

  private parseTimeRange(duration: string) {
    const now = Math.floor(Date.now() / 1000);
    const match = duration.match(/^(\d+)([mhd])$/);
    if (!match) throw new Error(`Invalid duration: ${duration}`);
    const value = parseInt(match[1]);
    const unit = match[2];
    const seconds = unit === "m" ? value * 60 : unit === "h" ? value * 3600 : value * 86400;
    return { start: now - seconds, end: now };
  }

  private escapeLogQLValue(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  private escapeLogQLRegex(value: string): string {
    // Escape backticks which would break the LogQL regex delimiter
    return value.replace(/`/g, "\\`");
  }

  private buildAuthHeaders(): Record<string, string> {
    if (!this.auth || this.auth.type === "none") return {};
    if (this.auth.type === "bearer" && this.auth.token) {
      return { Authorization: `Bearer ${this.auth.token}` };
    }
    if (this.auth.type === "basic" && this.auth.username) {
      const encoded = Buffer.from(`${this.auth.username}:${this.auth.password || ""}`).toString("base64");
      return { Authorization: `Basic ${encoded}` };
    }
    return {};
  }

  private async apiGet<T>(path: string, timeoutMs = 10000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...this.fetchOptions(),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Loki API error: ${res.status} ${res.statusText}`);
      return res.json() as Promise<T>;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(`Loki query timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

// Loki API types
interface LokiQueryResponse {
  data: {
    resultType: string;
    result: Array<{
      stream: Record<string, string>;
      values: Array<[string, string]>;
    }>;
  };
}
