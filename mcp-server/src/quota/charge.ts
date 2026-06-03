/**
 * Pure helper that turns a TokenBudget decision into either the
 * original tool result (when allowed / uncapped) or a structured
 * error payload distinguishing the two budget-denial cases:
 *
 *   - OMCP_TOKEN_BUDGET_EXCEEDED         — cumulative trailing-24h
 *     usage would push the principal past its cap. Waiting helps;
 *     `retryAfterSeconds` says how long until enough buckets drop
 *     off to fit the request.
 *
 *   - OMCP_TOKEN_REQUEST_EXCEEDS_BUDGET  — this single response is
 *     larger than the entire daily cap. Waiting does NOT help — the
 *     agent must narrow the query or the operator must raise the
 *     cap. `retryAfterSeconds` is 0 here so retry-with-backoff loops
 *     terminate instead of churning.
 *
 * Extracted from the createMcpServer closure in index.ts purely for
 * unit-testability. Behaviour is identical to the previous inline
 * version.
 */
import type { CheckResult } from "./token-budget.js";

export interface ToolResult {
  content: Array<{ text: string; [k: string]: unknown }>;
}

export function applyBudgetDecision<T extends ToolResult>(
  result: T,
  decision: CheckResult,
  tokens: number,
  toolName: string,
): T {
  if (decision.allowed || decision.limit === 0) return result;
  // A request larger than the entire daily cap can never succeed by
  // waiting — distinct error code so the agent doesn't spin.
  const requestExceedsCap = tokens > decision.limit;
  const errBody = {
    error: requestExceedsCap ? "OMCP_TOKEN_REQUEST_EXCEEDS_BUDGET" : "OMCP_TOKEN_BUDGET_EXCEEDED",
    tool: toolName,
    used: decision.used,
    limit: decision.limit,
    requested: tokens,
    retryAfterSeconds: requestExceedsCap ? 0 : decision.retryAfterSeconds,
    freedAtRetry: decision.freedAtRetry,
    message: requestExceedsCap
      ? `This single response (~${tokens} tokens) is larger than the entire daily budget (${decision.limit}). Retrying won't help — narrow the query (smaller window / lower limit / more selective filter) or raise OMCP_TOOL_DAILY_TOKENS.`
      : `Daily token budget exceeded (${decision.used}/${decision.limit} tokens used in the trailing 24h; this call would have added ~${tokens}). Try again in ~${Math.ceil(decision.retryAfterSeconds / 3600)}h or raise OMCP_TOOL_DAILY_TOKENS.`,
  };
  // Preserve any additional content entries (e.g. a future tool
  // returning [text, image]) — only the text payload of the first
  // entry is replaced with the error JSON; everything after passes
  // through unchanged.
  return {
    ...result,
    content: [
      { ...result.content[0], text: JSON.stringify(errBody) },
      ...result.content.slice(1),
    ],
  } as T;
}
