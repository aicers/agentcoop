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
 * Send a follow-up prompt to the agent by resuming the session.
 *
 * Throws if `sessionId` is undefined — a follow-up without session
 * context would produce an ungrounded response because the agent has
 * never seen the preceding conversation.
 */
export async function sendFollowUp(
  agent: AgentAdapter,
  sessionId: string | undefined,
  prompt: string,
  cwd: string,
): Promise<AgentResult> {
  if (sessionId === undefined) {
    throw new Error(
      "Cannot send follow-up: no session ID from the previous turn. " +
        "The agent CLI may have failed to return a session.",
    );
  }
  const stream = agent.resume(sessionId, prompt, { cwd });
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

/**
 * Map a fix-or-done / verify-or-done response to a `StageResult`.
 *
 * The step parser maps both FIXED and DONE to `"fixed"` status.  We
 * distinguish by keyword:
 *   - DONE  → `"completed"` (stage done, pipeline advances)
 *   - FIXED → `"not_approved"` (pipeline loops back)
 *
 * Shared by the self-check (stage 3) and test-plan verification
 * (stage 6) handlers.
 */
export function mapFixOrDoneResponse(responseText: string): StageResult {
  const parsed = parseStepStatus(responseText);

  if (parsed.status === "fixed" && parsed.keyword === "FIXED") {
    return mapParsedStepToResult(parsed, responseText, {
      fixed: "not_approved",
    });
  }

  return mapParsedStepToResult(parsed, responseText);
}
