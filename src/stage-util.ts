/**
 * Shared utilities for stage handlers — agent error mapping and
 * step-status-to-outcome conversion.
 */

import type { AgentAdapter, AgentResult, AgentStream } from "./agent.js";
import type { StageOutcome, StageResult } from "./pipeline.js";
import { type ParsedStep, parseStepStatus } from "./step-parser.js";

/**
 * Callback that receives streaming output chunks from an agent process.
 */
export type StreamSink = (chunk: string) => void;

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
 * Drain the async iterator of a stream, forwarding chunks to a sink.
 * The task runs detached — the returned promise is the stream's
 * `.result` (which resolves independently of the iterator).
 */
export function drainToSink(stream: AgentStream, sink: StreamSink): void {
  (async () => {
    try {
      for await (const chunk of stream) {
        sink(chunk);
      }
    } catch {
      // Fire-and-forget: sink errors must not become unhandled rejections.
    }
  })();
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
  sink?: StreamSink,
): Promise<AgentResult> {
  if (sessionId === undefined) {
    throw new Error(
      "Cannot send follow-up: no session ID from the previous turn. " +
        "The agent CLI may have failed to return a session.",
    );
  }
  const stream = agent.resume(sessionId, prompt, { cwd });
  if (sink) drainToSink(stream, sink);
  return stream.result;
}

/**
 * Invoke an agent, or resume an existing session if a saved session ID
 * is available.  Used on pipeline resume so stage handlers can continue
 * from a prior conversation.
 *
 * If `resume()` fails (e.g. expired session), falls back to a fresh
 * `invoke()` automatically.
 */
export async function invokeOrResume(
  agent: AgentAdapter,
  savedSessionId: string | undefined,
  prompt: string,
  cwd: string,
  sink?: StreamSink,
): Promise<AgentResult> {
  if (savedSessionId) {
    const stream = agent.resume(savedSessionId, prompt, { cwd });
    if (sink) drainToSink(stream, sink);
    const result = await stream.result;
    if (result.status === "success") {
      return result;
    }
    // Non-recoverable errors should be surfaced, not retried.
    if (
      result.errorType === "cli_not_found" ||
      result.errorType === "execution_error"
    ) {
      return result;
    }
    // Session expired or unknown error — fall back to fresh invoke.
  }
  const stream = agent.invoke(prompt, { cwd });
  if (sink) drainToSink(stream, sink);
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
