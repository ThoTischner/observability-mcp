// The Grafana API contract the connector must honour — single,
// reviewable source of truth for the contract test. Same rationale as
// the Datadog contract (see connectors/datadog/contract/contract.mjs):
// in-process, deterministic, no Prism container, no Grafana instance.
//
// The proxy paths embed fixed test datasource UIDs (prom-uid / loki-uid)
// so the contract can match on an exact pathname.

const PROM = "/api/datasources/proxy/uid/prom-uid";
const LOKI = "/api/datasources/proxy/uid/loki-uid";

export const CONTRACT = {
  "GET /api/health": {
    requiredHeaders: ["Authorization"],
    response: { database: "ok", version: "11.0.0" },
  },
  "GET /api/datasources": {
    requiredHeaders: ["Authorization"],
    response: [
      { type: "prometheus", uid: "prom-uid", name: "Prometheus" },
      { type: "loki", uid: "loki-uid", name: "Loki" },
    ],
  },
  [`GET ${PROM}/api/v1/query_range`]: {
    requiredHeaders: ["Authorization"],
    requiredQuery: { query: "nonempty", start: "int", end: "int", step: "int" },
    response: {
      status: "success",
      data: { resultType: "matrix", result: [{ metric: { service: "checkout" }, values: [[1715760000, "12.5"], [1715760060, "18.2"]] }] },
    },
  },
  [`GET ${PROM}/api/v1/label/service/values`]: {
    requiredHeaders: ["Authorization"],
    response: { status: "success", data: ["checkout", "payments"] },
  },
  [`GET ${LOKI}/loki/api/v1/query_range`]: {
    requiredHeaders: ["Authorization"],
    requiredQuery: { query: "nonempty", start: "int", end: "int", limit: "int" },
    response: {
      status: "success",
      data: {
        resultType: "streams",
        result: [
          { stream: { service: "checkout", level: "error" }, values: [["1715760000000000000", "boom"]] },
          { stream: { service: "checkout", level: "info" }, values: [["1715760060000000000", "ok"]] },
        ],
      },
    },
  },
};

export function checkRequest(method, url, headers) {
  const u = new URL(url);
  const key = `${method.toUpperCase()} ${u.pathname}`;
  const rule = CONTRACT[key];
  if (!rule) return `unexpected request: ${key} (not in the Grafana contract)`;
  for (const h of rule.requiredHeaders || []) {
    const v = headers ? headers[h] : undefined;
    if (v == null || v === "") return `${key}: missing required header ${h}`;
    if (h === "Authorization" && !/^Bearer .+/.test(v)) return `${key}: Authorization must be 'Bearer <token>'`;
  }
  for (const [q, kind] of Object.entries(rule.requiredQuery || {})) {
    const v = u.searchParams.get(q);
    if (v == null) return `${key}: missing required query param '${q}'`;
    if (kind === "int" && !/^-?\d+$/.test(v)) return `${key}: query '${q}'='${v}' is not an integer`;
    if (kind === "nonempty" && v.length === 0) return `${key}: query '${q}' is empty`;
  }
  return null;
}
