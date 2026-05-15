// The Elasticsearch API contract the connector must honour — single,
// reviewable source of truth for the contract test. Same rationale as
// the Datadog/Grafana contracts: in-process, deterministic, no ES
// instance, no Prism. (encodeURIComponent leaves "logs-*" unchanged,
// so the search path is stable.)

export const CONTRACT = {
  "GET /_cluster/health": {
    requiredHeaders: ["Authorization"],
    response: { status: "green", cluster_name: "es" },
  },
  "POST /logs-*/_search": {
    requiredHeaders: ["Authorization", "Content-Type"],
    // body is JSON; route the example response by what the body asks for
    response: (body) => {
      if (body && body.aggs && body.aggs.svc) {
        return { aggregations: { svc: { buckets: [{ key: "checkout" }, { key: "payments" }] } } };
      }
      if (body && body.aggs && body.aggs.ts) {
        return { aggregations: { ts: { buckets: [
          { key: 1715760000000, doc_count: 30 },
          { key: 1715760060000, doc_count: 12 },
        ] } } };
      }
      return { hits: { hits: [
        { _source: { "@timestamp": "2026-05-16T10:00:00.000Z", log: { level: "error" }, message: "boom", service: { name: "checkout" } } },
        { _source: { "@timestamp": "2026-05-16T10:01:00.000Z", log: { level: "info" }, message: "ok", service: { name: "checkout" } } },
      ] } };
    },
  },
};

export function checkRequest(method, url, headers, body) {
  const u = new URL(url);
  const key = `${method.toUpperCase()} ${u.pathname}`;
  const rule = CONTRACT[key];
  if (!rule) return `unexpected request: ${key} (not in the Elasticsearch contract)`;
  for (const h of rule.requiredHeaders || []) {
    const v = headers ? headers[h] : undefined;
    if (v == null || v === "") return `${key}: missing required header ${h}`;
    if (h === "Authorization" && !/^(ApiKey|Basic) .+/.test(v)) {
      return `${key}: Authorization must be 'ApiKey <key>' or 'Basic <creds>'`;
    }
  }
  if (method.toUpperCase() === "POST") {
    let parsed;
    try {
      parsed = typeof body === "string" ? JSON.parse(body) : body;
    } catch {
      return `${key}: body is not valid JSON`;
    }
    if (!parsed || typeof parsed.query !== "object") return `${key}: body.query (bool filter) required`;
  }
  return null;
}
