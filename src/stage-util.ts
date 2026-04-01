/**
 * Shared utilities for stage handlers — agent error mapping and
 * step-status-to-outcome conversion.
 */

import type { AgentAdapter, AgentResult } from "./agent.js";
import type { StageOutcome, StageResult } from "./pipeline.js";
import { type ParsedStep, parseStepStatus } from "./step-parser.js";

/**
 * Map an `AgentResult` with `status === "error"` to a `StageResult`.
 * The optional `context` string is included in the message for
 * diagnostics (e.g. "during self-check").
 */
export function mapAgentError(
  result: AgentResult,
  context?: string,
): StageResult {
  const during = context ? ` ${context}` : "";
  if (result.errorType === "max_turns") {
    return {
      outcome: "error",
      message: `Agent hit the maximum turn limit${during}.`,
    };
  }
  const detail = result.stderrText || result.errorType || "unknown";
  return {
    outcome: "error",
    message: `Agent error${during}: ${detail}`,
  };
}

/**
 * Convert a `ParsedStep` (from `parseStepStatus`) to a `StageOutcome`.
 *
 * By default every terminal keyword maps to `"completed"`.  Callers can
 * supply `overrides` to remap specific statuses — for example the
 * self-check stage maps the FIXED keyword to `"not_approved"` so the
 * pipeline loops.
 */
export function mapParsedStepToResult(
  parsed: ParsedStep,
  responseText: string,
  overrides?: Partial<Record<ParsedStep["status"], StageOutcome>>,
): StageResult {
  const outcomeMap: Record<ParsedStep["status"], StageOutcome> = {
    completed: "completed",
    fixed: "completed",
    approved: "completed",
    not_approved: "not_approved",
    blocked: "blocked",
    ambiguous: "needs_clarification",
    ...overrides,
  };

  return {
    outcome: outcomeMap[parsed.status],
    message: responseText,
  };
}

/**
 * Send a follow-up prompt to the agent, resuming the session if a
 * `sessionId` is available and falling back to a fresh `invoke`
 * otherwise.
 */
export async function sendFollowUp(
  agent: AgentAdapter,
  sessionId: string | undefined,
  prompt: string,
  cwd: string,
): Promise<AgentResult> {
  const stream = sessionId
    ? agent.resume(sessionId, prompt, { cwd })
    : agent.invoke(prompt, { cwd });
  return stream.result;
}

/**
 * Convenience: parse response text and convert to a `StageResult` in one
 * call.
 */
export function mapResponseToResult(
  responseText: string,
  overrides?: Partial<Record<ParsedStep["status"], StageOutcome>>,
): StageResult {
  return mapParsedStepToResult(
    parseStepStatus(responseText),
    responseText,
    overrides,
  );
}
