const serviceName = process.env.SERVICE_NAME || "unknown";

type LogLevel = "info" | "warn" | "error" | "debug";

export function log(level: LogLevel, msg: string, extra?: Record<string, unknown>) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: serviceName,
    msg,
    ...extra,
  };
  const out = level === "error" ? process.stderr : process.stdout;
  out.write(JSON.stringify(entry) + "\n");
}
