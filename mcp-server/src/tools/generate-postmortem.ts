// generate_postmortem — Phase F19a.
//
// Stitches together anomaly history (F15), trace summaries (F13),
// and the topology blast-radius (existing get_blast_radius
// machinery) into a single markdown post-mortem report.
//
// The synthesizer is pure compute (see ./../postmortem/synthesizer);
// this handler is just the orchestration: pull each upstream
// primitive in parallel, hand the result to the synthesizer.

import type { ConnectorRegistry } from "../connectors/registry.js";
import { defaultContext, type RequestContext } from "../context.js";
import { validateDuration, validateServiceName, errorResponse } from "./validation.js";
import {
  synthesizePostmortem,
  type AnomalySample,
  type BlastRadiusNode,
  type TraceSummary,
} from "../postmortem/synthesizer.js";
import type { MetricResult, TraceResult } from "../types.js";

export const generatePostmortemDefinition = {
  name: "generate_postmortem" as const,
  description: [
    "Stitch the gateway's primitives (anomaly history, blast-radius, traces, log highlights) into a single markdown post-mortem report for one service over a given window.",
    "When to use: after an incident, when the operator or LLM wants 'one document the on-call can read in 60 seconds' instead of poking the individual tools.",
    "Prerequisites: anomaly history requires OMCP_ANOMALY_HISTORY_REMOTE_WRITE configured AND a Prometheus source pointed at the same TSDB (see docs/anomaly-history.md). Traces require a Tempo / Jaeger source. Blast-radius requires a topology provider.",
    "Behavior: read-only. Returns BOTH a structured JSON shape AND a markdown body suitable to paste straight into a ticket. Output is capped (timeline truncated to 20 rows in the markdown, 30 nodes in the blast radius table, 10 traces) — the structured shape carries the full data.",
    "Related: `get_anomaly_history` for the raw scores; `query_traces` for individual traces; `get_blast_radius` for the topology.",
  ].join(" "),
  inputSchema: {
    type: "object" as const,
    properties: {
      service: { type: "string", description: "Suspected root-cause service (the operator's first guess)." },
      duration: { type: "string", description: "Rolling window the incident took place in, e.g. '1h', '6h'. Default '1h'." },
      format: { type: "string", description: "Output format: 'markdown' (default) or 'json'." },
    },
    required: ["service"],
  },
};

export async function generatePostmortemHandler(
  registry: ConnectorRegistry,
  args: { service: string; duration?: string; format?: string },
  ctx: RequestContext = defaultContext(),
) {
  const svcErr = validateServiceName(args.service);
  if (svcErr) return errorResponse(svcErr);
  const duration = args.duration || "1h";
  const durationErr = validateDuration(duration);
  if (durationErr) return errorResponse(durationErr);

  const now = new Date();
  const fromIso = new Date(now.getTime() - parseDurationMs(duration)).toISOString();
  const toIso = now.toISOString();

  // Parallel-fetch every upstream primitive. Each fetch swallows
  // its own errors and returns an empty result — the post-mortem
  // must always synthesise SOMETHING (even "no signal found").
  const [anomalies, traces, blastRadius, logHighlights] = await Promise.all([
    fetchAnomalies(registry, args.service, duration, ctx),
    fetchTraces(registry, args.service, duration, ctx),
    fetchBlastRadius(registry, args.service, ctx),
    fetchLogHighlights(registry, args.service, duration, ctx),
  ]);

  const report = synthesizePostmortem({
    service: args.service,
    window: duration,
    tenant: ctx.tenant || "default",
    fromIso,
    toIso,
    anomalies,
    blastRadius,
    traces,
    logHighlights,
  });

  if ((args.format || "markdown").toLowerCase() === "json") {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(report) }],
      isError: false,
    };
  }
  // Default: return the markdown body. The structured sections live
  // in JSON if the caller asked for them.
  return {
    content: [{ type: "text" as const, text: report.markdown }],
    isError: false,
  };
}

function parseDurationMs(d: string): number {
  const m = d.match(/^(\d+)([smhd])$/);
  if (!m) return 60 * 60 * 1000;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  return unit === "s" ? n * 1000
       : unit === "m" ? n * 60_000
       : unit === "h" ? n * 3_600_000
       :                n * 86_400_000;
}

async function fetchAnomalies(
  registry: ConnectorRegistry,
  service: string,
  duration: string,
  ctx: RequestContext,
): Promise<AnomalySample[]> {
  const metric = `omcp_anomaly_score{service="${escLabel(service)}"}`;
  for (const c of registry.getByTenant(ctx.tenant).filter((x) => typeof x.queryMetrics === "function")) {
    try {
      const r: MetricResult | undefined = await c.queryMetrics!({ service, metric, duration });
      if (r && r.values && r.values.length > 0) {
        return r.values.map((v) => ({
          ts: typeof v.timestamp === "number" ? new Date(v.timestamp).toISOString() : String(v.timestamp),
          service,
          score: typeof v.value === "number" ? v.value : Number(v.value) || 0,
          method: "mad",
          severity: "warn",
        }));
      }
    } catch {
      /* fall through to next source */
    }
  }
  return [];
}

async function fetchTraces(
  registry: ConnectorRegistry,
  service: string,
  duration: string,
  ctx: RequestContext,
): Promise<TraceSummary[]> {
  for (const c of registry.getByTenant(ctx.tenant).filter((x) => typeof x.queryTraces === "function")) {
    try {
      const r: TraceResult | undefined = await c.queryTraces!({ service, duration, limit: 10 });
      if (r && r.traces && r.traces.length > 0) {
        return r.traces.map((t) => ({
          traceId: t.traceId,
          rootName: t.rootName,
          rootService: t.rootService,
          durationMs: t.durationMs,
          hasError: t.hasError,
        }));
      }
    } catch {
      /* fall through */
    }
  }
  return [];
}

async function fetchBlastRadius(
  registry: ConnectorRegistry,
  service: string,
  ctx: RequestContext,
): Promise<{ nodes: BlastRadiusNode[]; edges: Array<{ from: string; to: string; relation: string }> }> {
  // We don't have a direct "give me blast radius for service X" helper at
  // this layer — the existing get_blast_radius is a tool that takes a
  // resource id. For the post-mortem we settle for the full topology
  // snapshot of the caller's tenant and let the synthesizer mark the
  // suspect-named node as root. Future F19b can plumb the real walker.
  for (const c of registry.getByTenant(ctx.tenant)) {
    if (typeof c.getTopologySnapshot !== "function") continue;
    try {
      const snap = await c.getTopologySnapshot!();
      if (!snap?.resources?.length) continue;
      // Pick nodes whose name matches the suspected service (case-
      // insensitive substring is conservative-enough for the
      // synopsis; the real walker can be precise later).
      const needle = service.toLowerCase();
      const matching = snap.resources.filter((r) =>
        r.name?.toLowerCase().includes(needle) ||
        (r.labels && Object.values(r.labels).some((v) => String(v).toLowerCase() === needle)),
      );
      if (matching.length === 0) continue;
      const matchedIds = new Set(matching.map((r) => r.id));
      const connected = snap.edges.filter((e) => matchedIds.has(e.from) || matchedIds.has(e.to));
      const neighborIds = new Set([
        ...matching.map((r) => r.id),
        ...connected.map((e) => e.from),
        ...connected.map((e) => e.to),
      ]);
      const nodes: BlastRadiusNode[] = snap.resources
        .filter((r) => neighborIds.has(r.id))
        .map((r) => ({
          id: r.id,
          kind: r.kind,
          name: r.name,
          root: matchedIds.has(r.id),
        }));
      return {
        nodes,
        edges: connected.map((e) => ({ from: e.from, to: e.to, relation: e.relation })),
      };
    } catch {
      /* fall through */
    }
  }
  return { nodes: [], edges: [] };
}

async function fetchLogHighlights(
  registry: ConnectorRegistry,
  service: string,
  duration: string,
  ctx: RequestContext,
): Promise<string[]> {
  for (const c of registry.getByTenant(ctx.tenant).filter((x) => typeof x.queryLogs === "function")) {
    try {
      const r = await c.queryLogs!({ service, duration, limit: 5 });
      if (r?.summary?.errorCount && r.summary.errorCount > 0) {
        return [`${service}: ${r.summary.errorCount} error log line(s) in window (source: ${r.source}).`];
      }
    } catch {
      /* skip */
    }
  }
  return [];
}

function escLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
