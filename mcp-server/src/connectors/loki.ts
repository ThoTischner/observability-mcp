import type { ObservabilityConnector } from "./interface.js";
import type {
  SourceConfig,
  ConnectorHealth,
  ServiceInfo,
  MetricDefinition,
  LogQuery,
  LogResult,
  LogEntry,
  SignalType,
} from "../types.js";

export class LokiConnector implements ObservabilityConnector {
  readonly type = "loki";
  readonly signalType: SignalType = "logs";
  name = "";
  private baseUrl = "";

  async connect(config: SourceConfig): Promise<void> {
    this.name = config.name;
    this.baseUrl = config.url.replace(/\/$/, "");
  }

  getDefaultMetrics(): MetricDefinition[] {
    // Loki is a log backend — no metric definitions by default
    return [];
  }

  getMetrics(): MetricDefinition[] {
    return [];
  }

  async healthCheck(): Promise<ConnectorHealth> {
    const start = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/ready`);
      const text = await res.text();
      const isReady = res.ok && text.trim() === "ready";
      return {
        status: isReady ? "up" : "down",
        latencyMs: Date.now() - start,
        message: isReady ? "Loki is ready" : `HTTP ${res.status}: ${text}`,
      };
    } catch (err) {
      return { status: "down", latencyMs: Date.now() - start, message: String(err) };
    }
  }

  async disconnect(): Promise<void> {}

  async listServices(): Promise<ServiceInfo[]> {
    try {
      const data = await this.apiGet<{ data: string[] }>(
        "/loki/api/v1/label/service/values"
      );
      return (data?.data || []).map((name) => ({
        name,
        source: this.name,
        signalType: "logs" as const,
      }));
    } catch {
      return [];
    }
  }

  async queryLogs(params: LogQuery): Promise<LogResult> {
    const { start, end } = this.parseTimeRange(params.duration);
    const limit = Math.min(Math.max(params.limit || 100, 1), 1000);

    const service = this.escapeLogQLValue(params.service);
    let logql = `{service="${service}"}`;
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

  private async apiGet<T>(path: string, timeoutMs = 10000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { signal: controller.signal });
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
