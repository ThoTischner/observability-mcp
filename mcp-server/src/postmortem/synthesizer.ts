// Auto-post-mortem synthesizer — Phase F19.
//
// Stitches together the existing observability primitives — anomaly
// history (F15), blast-radius (F13/topology), trace summaries (F13),
// log-derived error patterns (existing query_logs) — into a single
// markdown report a human (or LLM) can read in one shot.
//
// The synthesizer is pure-ish: it accepts the upstream queries as
// injected functions so the tool layer can compose them without the
// synthesizer depending on the entire ConnectorRegistry API. Tests
// inject fake data and don't need a live demo stack.

export interface AnomalySample {
  ts: string;
  service: string;
  score: number;
  method: string;
  severity: string;
  signal?: string;
}

export interface BlastRadiusNode {
  id: string;
  kind: string;
  name: string;
  /** Whether this node is the suspected root cause (the input service). */
  root?: boolean;
}

export interface TraceSummary {
  traceId: string;
  rootName: string;
  rootService: string;
  durationMs: number;
  hasError: boolean;
}

export interface PostmortemInput {
  /** Suspected root-cause service (the operator's first guess). */
  service: string;
  /** Rolling window the incident took place in, e.g. "2h", "6h". */
  window: string;
  /** Tenant the incident occurred in. */
  tenant: string;
  /** RFC-3339 start + end of the incident window for human display. */
  fromIso: string;
  toIso: string;
  /** Live anomaly samples within the window. */
  anomalies: AnomalySample[];
  /** Blast-radius graph at peak. */
  blastRadius: { nodes: BlastRadiusNode[]; edges: Array<{ from: string; to: string; relation: string }> };
  /** Trace summaries (top by duration). */
  traces: TraceSummary[];
  /** Optional log-error summary lines, e.g. ["payment-service: 412 5xx in window"]. */
  logHighlights?: string[];
  /** Optional custom report template (issue: v3.3 candidate). When set, the
   *  markdown body is rendered by interpolating `{{placeholder}}` tokens
   *  instead of the built-in layout. Unset → the default report (unchanged).
   *  Available tokens: service, window, from, to, tenant, synopsis, timeline,
   *  blastRadius, signals, traces, logHighlights, followUps. An unknown token
   *  is left verbatim so a typo is visible rather than silently dropped. */
  template?: string;
}

export interface PostmortemReport {
  service: string;
  window: string;
  fromIso: string;
  toIso: string;
  /** Compact synopsis the UI puts at the top of the report. */
  synopsis: string;
  /** Markdown body of the full report. */
  markdown: string;
  /** Structured form for callers that want to render their own UI. */
  sections: {
    timeline: Array<{ ts: string; service: string; score: number; severity: string; method: string }>;
    blastRadius: { nodes: BlastRadiusNode[]; edgeCount: number };
    topTraces: TraceSummary[];
    contributingSignals: Array<{ signal: string; count: number; meanScore: number }>;
    followUps: string[];
    logHighlights: string[];
  };
}

/** Synthesise one report from already-fetched primitives. Pure
 *  compute — no I/O. */
export function synthesizePostmortem(input: PostmortemInput): PostmortemReport {
  const timeline = [...input.anomalies]
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .map((a) => ({ ts: a.ts, service: a.service, score: a.score, severity: a.severity, method: a.method }));

  const contributingSignals = aggregateBySignal(input.anomalies);
  const peakScore = input.anomalies.reduce((m, a) => Math.max(m, a.score), 0);
  const errorTraces = input.traces.filter((t) => t.hasError).length;
  const peakNode = input.blastRadius.nodes.find((n) => n.root) ?? input.blastRadius.nodes[0];
  const blastSize = input.blastRadius.nodes.length;

  const followUps = inferFollowUps(input, { peakScore, errorTraces, blastSize });

  const synopsis = synopsisFor(input, peakScore, errorTraces, blastSize);

  const renderCtx = {
    input,
    timeline,
    contributingSignals,
    peakNode,
    peakScore,
    errorTraces,
    blastSize,
    followUps,
    synopsis,
  };
  // Default layout unless the operator supplied a custom template — the
  // default path is byte-for-byte unchanged.
  const markdown = input.template
    ? renderTemplate(input.template, buildTemplateVars(renderCtx))
    : renderMarkdown(renderCtx);

  return {
    service: input.service,
    window: input.window,
    fromIso: input.fromIso,
    toIso: input.toIso,
    synopsis,
    markdown,
    sections: {
      timeline,
      blastRadius: { nodes: input.blastRadius.nodes, edgeCount: input.blastRadius.edges.length },
      topTraces: input.traces.slice(0, 10),
      contributingSignals,
      followUps,
      logHighlights: input.logHighlights ?? [],
    },
  };
}

function aggregateBySignal(anomalies: AnomalySample[]): Array<{ signal: string; count: number; meanScore: number }> {
  const groups = new Map<string, number[]>();
  for (const a of anomalies) {
    const sig = a.signal ?? a.method;
    const prev = groups.get(sig);
    if (prev) prev.push(a.score);
    else groups.set(sig, [a.score]);
  }
  return [...groups.entries()]
    .map(([signal, scores]) => ({
      signal,
      count: scores.length,
      meanScore: Math.round((scores.reduce((s, x) => s + x, 0) / scores.length) * 100) / 100,
    }))
    .sort((a, b) => b.meanScore - a.meanScore);
}

function inferFollowUps(
  input: PostmortemInput,
  ctx: { peakScore: number; errorTraces: number; blastSize: number },
): string[] {
  const out: string[] = [];
  if (input.anomalies.length === 0) {
    out.push("No anomaly history found for this service in the window — confirm OMCP_ANOMALY_HISTORY_REMOTE_WRITE is wired and Prometheus is scraping the same TSDB.");
    return out;
  }
  if (ctx.peakScore >= 0.9) {
    out.push(`Peak anomaly score ${ctx.peakScore} is critical — review the detector's threshold for service '${input.service}' and consider whether the chosen method (${dominantMethod(input.anomalies)}) suits this signal's distribution.`);
  }
  if (ctx.errorTraces > 0) {
    out.push(`${ctx.errorTraces} trace(s) carried error spans during the window — drill into the slowest via \`query_traces(service="${input.service}", errorsOnly=true)\`.`);
  }
  if (ctx.blastSize > 5) {
    out.push(`Blast radius spans ${ctx.blastSize} nodes — verify that the dependency edges are still accurate (a stale topology snapshot can blow up the radius and miss the real cause).`);
  }
  if ((input.logHighlights ?? []).length > 0) {
    out.push("Log highlights above point at concrete error patterns — promote the recurring ones to an alert or SLO so the next regression catches itself.");
  }
  if (out.length === 0) {
    out.push("All signals look stable for this window — consider closing the incident as a transient anomaly or expanding the time window.");
  }
  return out;
}

function dominantMethod(anomalies: AnomalySample[]): string {
  const c = new Map<string, number>();
  for (const a of anomalies) c.set(a.method, (c.get(a.method) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
}

function synopsisFor(
  input: PostmortemInput,
  peakScore: number,
  errorTraces: number,
  blastSize: number,
): string {
  const anomalyCount = input.anomalies.length;
  if (anomalyCount === 0) {
    return `No anomalies recorded for service '${input.service}' between ${input.fromIso} and ${input.toIso}. Either the window was clean, or the history sink wasn't writing at the time.`;
  }
  return [
    `Service '${input.service}' produced ${anomalyCount} anomaly sample(s) between ${input.fromIso} and ${input.toIso}, peaking at ${peakScore}.`,
    `Blast radius at peak covered ${blastSize} node(s); ${errorTraces} trace(s) carried error spans.`,
  ].join(" ");
}

function renderMarkdown(ctx: {
  input: PostmortemInput;
  timeline: PostmortemReport["sections"]["timeline"];
  contributingSignals: PostmortemReport["sections"]["contributingSignals"];
  peakNode: BlastRadiusNode | undefined;
  peakScore: number;
  errorTraces: number;
  blastSize: number;
  followUps: string[];
  synopsis: string;
}): string {
  const { input, timeline, contributingSignals, peakNode, peakScore, errorTraces, followUps, synopsis } = ctx;
  const lines: string[] = [];
  lines.push(`# Post-mortem — ${input.service}`);
  lines.push("");
  lines.push(`> **Window:** \`${input.fromIso}\` → \`${input.toIso}\` (\`${input.window}\`)  `);
  lines.push(`> **Tenant:** \`${input.tenant}\`  `);
  lines.push(`> **Generated by:** observability-mcp \`generate_postmortem\``);
  lines.push("");
  lines.push("## Synopsis");
  lines.push("");
  lines.push(synopsis);
  lines.push("");
  lines.push("## Anomaly timeline");
  lines.push("");
  if (timeline.length === 0) {
    lines.push("_No anomaly samples in this window._");
  } else {
    lines.push("| ts | service | score | severity | method |");
    lines.push("|---|---|---|---|---|");
    for (const t of timeline.slice(0, 20)) {
      lines.push(`| \`${t.ts}\` | \`${t.service}\` | ${t.score} | ${t.severity} | ${t.method} |`);
    }
    if (timeline.length > 20) lines.push(`| … | _${timeline.length - 20} more rows_ |  |  |  |`);
  }
  lines.push("");
  lines.push("## Blast radius at peak");
  lines.push("");
  if (peakNode) {
    lines.push(`Root node: **\`${peakNode.name}\`** (\`${peakNode.kind}\`).`);
  } else {
    lines.push("_Topology snapshot empty._");
  }
  lines.push("");
  if (input.blastRadius.nodes.length > 0) {
    lines.push("| node | kind |");
    lines.push("|---|---|");
    for (const n of input.blastRadius.nodes.slice(0, 30)) {
      lines.push(`| \`${n.name}\`${n.root ? " *(root)*" : ""} | \`${n.kind}\` |`);
    }
  }
  lines.push("");
  lines.push(`Edges in radius: **${input.blastRadius.edges.length}**.`);
  lines.push("");
  lines.push("## Contributing signals (ranked)");
  lines.push("");
  if (contributingSignals.length === 0) {
    lines.push("_No anomaly samples to rank._");
  } else {
    lines.push("| signal | samples | mean score |");
    lines.push("|---|---|---|");
    for (const s of contributingSignals.slice(0, 10)) {
      lines.push(`| \`${s.signal}\` | ${s.count} | ${s.meanScore} |`);
    }
  }
  lines.push("");
  lines.push("## Related traces");
  lines.push("");
  if (input.traces.length === 0) {
    lines.push("_No traces returned for the window. Configure a Tempo / Jaeger source if traces are expected._");
  } else {
    lines.push("| trace | service | duration ms | error |");
    lines.push("|---|---|---|---|");
    for (const t of input.traces.slice(0, 10)) {
      lines.push(`| \`${t.traceId}\` | \`${t.rootService}\` | ${t.durationMs} | ${t.hasError ? "yes" : "no"} |`);
    }
    if (errorTraces > 0) lines.push(`\n_${errorTraces} of the returned traces carried error spans._`);
  }
  lines.push("");
  if ((input.logHighlights ?? []).length > 0) {
    lines.push("## Log highlights");
    lines.push("");
    for (const l of input.logHighlights!) lines.push(`- ${l}`);
    lines.push("");
  }
  lines.push("## Suggested follow-ups");
  lines.push("");
  for (const f of followUps) lines.push(`- ${f}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(`*Generated by observability-mcp \`generate_postmortem\` — see \`docs/postmortems.md\` for the prompt sources.*`);
  lines.push("");
  // Bound the chunk to keep memory predictable; the rendered report
  // is normally a few KB but a pathological 10k-sample timeline
  // could approach MB without the slice() caps above.
  return lines.join("\n");
}

// --- Custom template engine (v3.3 candidate) -------------------------------
// Operators can override the report layout with a template of `{{token}}`
// placeholders. The default path (no template) is unchanged. Each token maps
// to a pre-rendered markdown block so a template author composes sections
// without re-implementing the table rendering.

type RenderCtx = {
  input: PostmortemInput;
  timeline: PostmortemReport["sections"]["timeline"];
  contributingSignals: PostmortemReport["sections"]["contributingSignals"];
  peakNode: BlastRadiusNode | undefined;
  peakScore: number;
  errorTraces: number;
  blastSize: number;
  followUps: string[];
  synopsis: string;
};

/** Build the `{{token}}` → markdown-block map for a custom template. */
export function buildTemplateVars(ctx: RenderCtx): Record<string, string> {
  const { input, timeline, contributingSignals, peakNode, errorTraces, followUps, synopsis } = ctx;

  const timelineBlock = timeline.length === 0
    ? "_No anomaly samples in this window._"
    : ["| ts | service | score | severity | method |", "|---|---|---|---|---|",
       ...timeline.slice(0, 20).map((t) => `| \`${t.ts}\` | \`${t.service}\` | ${t.score} | ${t.severity} | ${t.method} |`),
       ...(timeline.length > 20 ? [`| … | _${timeline.length - 20} more rows_ |  |  |  |`] : [])].join("\n");

  const brLines: string[] = [];
  brLines.push(peakNode ? `Root node: **\`${peakNode.name}\`** (\`${peakNode.kind}\`).` : "_Topology snapshot empty._");
  if (input.blastRadius.nodes.length > 0) {
    brLines.push("", "| node | kind |", "|---|---|",
      ...input.blastRadius.nodes.slice(0, 30).map((n) => `| \`${n.name}\`${n.root ? " *(root)*" : ""} | \`${n.kind}\` |`));
  }
  brLines.push("", `Edges in radius: **${input.blastRadius.edges.length}**.`);
  const blastRadiusBlock = brLines.join("\n");

  const signalsBlock = contributingSignals.length === 0
    ? "_No anomaly samples to rank._"
    : ["| signal | samples | mean score |", "|---|---|---|",
       ...contributingSignals.slice(0, 10).map((s) => `| \`${s.signal}\` | ${s.count} | ${s.meanScore} |`)].join("\n");

  const tracesBlock = input.traces.length === 0
    ? "_No traces returned for the window. Configure a Tempo / Jaeger source if traces are expected._"
    : ["| trace | service | duration ms | error |", "|---|---|---|---|",
       ...input.traces.slice(0, 10).map((t) => `| \`${t.traceId}\` | \`${t.rootService}\` | ${t.durationMs} | ${t.hasError ? "yes" : "no"} |`),
       ...(errorTraces > 0 ? [`\n_${errorTraces} of the returned traces carried error spans._`] : [])].join("\n");

  const logHighlightsBlock = (input.logHighlights ?? []).length === 0
    ? "_No log highlights._"
    : input.logHighlights!.map((l) => `- ${l}`).join("\n");

  const followUpsBlock = followUps.map((f) => `- ${f}`).join("\n");

  return {
    service: input.service,
    window: input.window,
    from: input.fromIso,
    to: input.toIso,
    tenant: input.tenant,
    synopsis,
    timeline: timelineBlock,
    blastRadius: blastRadiusBlock,
    signals: signalsBlock,
    traces: tracesBlock,
    logHighlights: logHighlightsBlock,
    followUps: followUpsBlock,
  };
}

/** Interpolate `{{token}}` placeholders. An unknown token is left verbatim so
 *  a typo is visible in the output rather than silently producing a blank. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z][\w]*)\s*\}\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole,
  );
}
