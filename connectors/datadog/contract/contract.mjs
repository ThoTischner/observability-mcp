// The Datadog API contract the connector is expected to honour — the
// single, reviewable source of truth for the contract test.
//
// Why not Prism + the upstream OpenAPI spec? Two reasons: (1) Datadog's
// authoritative spec is large, split across repos, and fetching it at
// test time is a fragile network/supply-chain dependency; (2) the
// prebuilt `stoplight/prism` container does not stay alive under every
// local Docker runtime, so a Prism-server test can't be reliably
// verified before shipping. This module instead encodes exactly the
// request shapes the connector must emit (modeled on Datadog's public
// API docs) plus representative responses, and the test enforces both
// in-process — deterministic, dependency-free, no account, no network.

export const CONTRACT = {
  "GET /api/v1/validate": {
    requiredHeaders: ["DD-API-KEY"],
    response: { valid: true },
  },
  "GET /api/v1/query": {
    requiredHeaders: ["DD-API-KEY"],
    requiredQuery: { from: "int", to: "int", query: "nonempty" },
    response: {
      status: "ok",
      series: [
        {
          scope: "service:checkout,env:prod",
          expression: "avg:system.cpu.user{service:checkout}",
          pointlist: [
            [1715760000000, 12.5],
            [1715760060000, null],
            [1715760120000, 18.2],
          ],
        },
      ],
    },
  },
  "POST /api/v2/logs/events/search": {
    requiredHeaders: ["DD-API-KEY"],
    requiredBodyKeys: ["filter"],
    bodyChecks: (b) => {
      if (typeof b.filter !== "object") return "filter must be an object";
      if (b.sort && !["timestamp", "-timestamp"].includes(b.sort)) return "sort enum violation";
      if (b.page && b.page.limit != null && b.page.limit > 1000) return "page.limit > 1000";
      return null;
    },
    response: {
      data: [
        { attributes: { timestamp: "2026-05-15T10:00:00.000Z", status: "error", message: "boom", service: "checkout" } },
        { attributes: { timestamp: "2026-05-15T10:01:00.000Z", status: "warn", message: "slow", service: "checkout" } },
        { attributes: { timestamp: "2026-05-15T10:02:00.000Z", status: "info", message: "ok", service: "checkout" } },
      ],
    },
  },
};

// Validate one captured request against the contract. Returns an error
// string, or null when the request conforms. This is the independent
// "spec engine" — it does not share code with the connector.
export function checkRequest(method, url, headers, body) {
  const u = new URL(url);
  const key = `${method.toUpperCase()} ${u.pathname}`;
  const rule = CONTRACT[key];
  if (!rule) return `unexpected request: ${key} (not in the Datadog contract)`;

  for (const h of rule.requiredHeaders || []) {
    if (!headers || headers[h] == null || headers[h] === "") return `${key}: missing required header ${h}`;
  }
  for (const [q, kind] of Object.entries(rule.requiredQuery || {})) {
    const v = u.searchParams.get(q);
    if (v == null) return `${key}: missing required query param '${q}'`;
    if (kind === "int" && !/^-?\d+$/.test(v)) return `${key}: query '${q}'='${v}' is not an integer`;
    if (kind === "nonempty" && v.length === 0) return `${key}: query '${q}' is empty`;
  }
  if (rule.requiredBodyKeys || rule.bodyChecks) {
    let parsed;
    try {
      parsed = typeof body === "string" ? JSON.parse(body) : body;
    } catch {
      return `${key}: body is not valid JSON`;
    }
    for (const k of rule.requiredBodyKeys || []) {
      if (!(k in (parsed || {}))) return `${key}: body missing required key '${k}'`;
    }
    if (rule.bodyChecks) {
      const err = rule.bodyChecks(parsed || {});
      if (err) return `${key}: ${err}`;
    }
  }
  return null;
}
