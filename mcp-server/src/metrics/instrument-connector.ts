import type { ObservabilityConnector } from "../connectors/interface.js";
import { connectorCalls } from "./self.js";

type Op =
  | "healthCheck"
  | "listServices"
  | "queryMetrics"
  | "queryLogs"
  | "listAvailableMetrics";

const OPS: Op[] = [
  "healthCheck",
  "listServices",
  "queryMetrics",
  "queryLogs",
  "listAvailableMetrics",
];

/**
 * Decorate a connector so every observable backend call increments
 * obsmcp_connector_calls_total{source,type,operation,outcome}. The
 * `source` label is filled in on first `connect()` once the config
 * is known. Keeps connector implementations free of metrics code.
 */
export function instrumentConnector<T extends ObservabilityConnector>(c: T): T {
  let source = "";
  const type = c.type;
  const wrappedConnect = c.connect.bind(c);
  c.connect = async (config) => {
    source = config.name;
    return wrappedConnect(config);
  };

  for (const op of OPS) {
    const fn = (c as unknown as Record<Op, undefined | ((...a: unknown[]) => unknown)>)[op];
    if (typeof fn !== "function") continue;
    const bound = fn.bind(c);
    (c as unknown as Record<Op, (...a: unknown[]) => unknown>)[op] = async (...args) => {
      try {
        const r = await bound(...args);
        connectorCalls.inc({ source: source || "<pending>", type, operation: op, outcome: "ok" });
        return r;
      } catch (err) {
        connectorCalls.inc({ source: source || "<pending>", type, operation: op, outcome: "error" });
        throw err;
      }
    };
  }
  return c;
}
