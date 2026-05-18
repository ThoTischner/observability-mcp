// The Grafana Tempo HTTP API contract the connector must honour —
// single, reviewable source of truth for the contract test. Same
// rationale as the Grafana/Datadog contracts: in-process,
// deterministic, no Tempo container, no Prism.
//
// Endpoints used (Tempo HTTP API):
//   GET /ready                                            — readiness
//   GET /api/v2/search/tag/resource.service.name/values   — service list
//   GET /api/search?q=<TraceQL>&start&end&limit            — trace search

export const CONTRACT = {
  "GET /ready": {
    requiredHeaders: [],
    response: "ready",
  },
  "GET /api/v2/search/tag/resource.service.name/values": {
    requiredHeaders: [],
    response: {
      tagValues: [
        { type: "string", value: "checkout" },
        { type: "string", value: "payments" },
      ],
    },
  },
  "GET /api/search": {
    requiredHeaders: [],
    requiredQuery: { q: "nonempty", start: "int", end: "int", limit: "int" },
    response: {
      traces: [
        { traceID: "a1", rootServiceName: "checkout", startTimeUnixNano: "1715760000000000000", durationMs: 120 },
        { traceID: "b2", rootServiceName: "checkout", startTimeUnixNano: "1715760060000000000", durationMs: 480 },
      ],
    },
  },
};

export function checkRequest(method, url, headers) {
  const u = new URL(url);
  const key = `${method.toUpperCase()} ${u.pathname}`;
  const rule = CONTRACT[key];
  if (!rule) return `unexpected request: ${key} (not in the Tempo contract)`;
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
