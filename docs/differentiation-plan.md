# Differentiation & validation plan

Status: active · Created 2026-05-16

This plan exists because an objective review found the project **excellently built but
strategically unproven**. Two weaknesses decide whether it matters:

1. **The differentiating feature is the weakest part.** The "intelligent analysis" is a
   naked z-score plus weighted health scoring — fragile on real, non-normal, seasonal
   observability data. Most engineering investment so far went into scaffolding (hub,
   signing, CI, Helm, listings), not the thing that is supposed to create value.
2. **The core thesis is unvalidated.** "Every vendor ships its own MCP server, agents
   must juggle N of them — we are the unified layer." MCP clients aggregate servers
   fine; there is no adoption evidence that this layer is needed at scale.

Guiding principle: **validate before build.** Cheap experiments that can *kill* the
thesis run before expensive engineering.

---

## Track A — make the analysis engine a real moat

Each item is a focused PR with tests and a **stated, measured** metric delta.

| ID | Package | Scope | Done when |
|----|---------|-------|-----------|
| A1 | Robust statistics | Replace mean/stddev with MAD/IQR (robust to skew/outliers); warmup (min samples); dwell/hysteresis (N consecutive breaches); per-metric-type detectors (latency p99 vs error-rate vs saturation) | False-positive rate on the synthetic suite drops materially; no cold-start flags; unit tests cover each detector |
| A2 | Seasonality-aware baseline | Compare against the same time-of-day / day-of-week window (seasonal-naive or EWMA/Holt-Winters) | Diurnal / load-cycle patterns no longer trigger anomalies on the seasonal fixture |
| A3 | **Backtesting harness** | Synthetic + NAB-style labelled series; precision / recall / F1 computed in CI as a quality gate; numbers published in the README | CI fails if detection quality regresses; README shows real scores |
| A4 | Causal correlation | Service graph from metric labels + anomaly onset ordering + deploy/change markers → a **ranked likely root cause**, not "both signals are bad" | The reproducible chaos incident is attributed to the true triggering cause |

Order: A1 → A2 → A3 → A4 (A1 first: biggest false-positive reduction, lowest risk;
A3 produces the credibility numbers).

## Track B — prove (or honestly kill) the thesis

| ID | Package | Scope | Done when |
|----|---------|-------|-----------|
| B1 | **Agent A/B (run first)** | A reproducible incident scenario; a real agent (Claude/Ollama) solves it twice: (a) against raw separate MCP servers, (b) against observability-mcp. Measure tokens, tool-call rounds, time-to-root-cause, answer correctness | A committed, re-runnable harness emits a comparison table; the result is reported honestly even if it is negative |
| B2 | Honest messaging | Drop the "Grafana for agents" tagline; precise testable claim + explicit ICP (SRE/platform teams on Prometheus+Loki using AI agents for incident triage) + one-page problem statement | README/USP reflect what is actually proven, no overselling |
| B3 | Real demo artifact | Replace the emulated demo GIF with a recording of a real agent run plus the B1 numbers | demo asset is reproducible and not staged |
| B4 | Distribution *(owner-driven)* | MCP catalog submissions (guide at `~/observability-mcp-hub-listing.md`), 2-minute Claude Desktop / Cursor / Cline quickstart, a short writeup, 30/60/90-day adoption targets, opt-in privacy-respecting usage signal | Adoption can actually be measured |
| B5 | Design partners *(owner-driven)* | 1–3 teams run it on real stacks; structured feedback | Reality check outside the demo |

## Sequencing

1. **B1 first** — cheap, and it can confirm or invalidate the entire direction.
2. Then **A1 → A2 → A3** (A3 yields the README numbers that convert "unproven
   differentiation" into evidence).
3. In parallel: **B2** (fast) and **B3** (builds on B1).
4. **A4** once B1 supports the thesis.
5. **B4 / B5** are owner-driven; the B1 result may reprioritise everything.

Agent/loop-doable: A1–A4, B1, B2, B3. Owner-only: B4 submissions, B5 partners.

Progress is tracked per PR; this document is updated as packages land.
