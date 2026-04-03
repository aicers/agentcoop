/**
 * Shared utilities for stage handlers — agent error mapping,
 * step-status-to-outcome conversion, and inactivity auto-resume.
 */

import type { AgentAdapter, AgentResult, AgentStream } from "./agent.js";
import { t } from "./i18n/index.js";
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
  const m = t();
  const during = context ? ` ${context}` : "";
  if (result.errorType === "max_turns") {
    return {
      outcome: "error",
      message: m["stageError.maxTurns"](during),
    };
  }
  if (result.errorType === "inactivity_timeout") {
    return {
      outcome: "error",
      message: m["stageError.inactivityTimeout"](during),
    };
  }
  if (result.errorType === "config_parsing") {
    const detail = result.stderrText || result.responseText || "unknown";
    return {
      outcome: "error",
      message: m["stageError.configParsing"](during, detail),
    };
  }
  const detail = result.stderrText || result.errorType || "unknown";
  return {
    outcome: "error",
    message: m["stageError.agentError"](during, detail),
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

// ---------------------------------------------------------------------------
// Inactivity auto-resume
// ---------------------------------------------------------------------------

const DEFAULT_RESUME_PROMPT = "Continue where you left off.";

/**
 * Retry an agent call on inactivity timeout.  Resumes the session with
 * a generic "continue" prompt up to `maxRetries` times, using
 * `fallbackSessionId` when the result lacks one.
 */
async function retryOnTimeout(
  agent: AgentAdapter,
  initial: AgentResult,
  cwd: string,
  fallbackSessionId: string | undefined,
  sink: StreamSink | undefined,
  maxRetries: number,
): Promise<AgentResult> {
  let result = initial;
  let left = maxRetries;

  while (result.errorType === "inactivity_timeout" && left > 0) {
    const sid = result.sessionId ?? fallbackSessionId;
    if (!sid) break;
    left--;
    const stream = agent.resume(sid, DEFAULT_RESUME_PROMPT, { cwd });
    if (sink) drainToSink(stream, sink);
    result = await stream.result;
  }

  return result;
}

/**
 * Invoke-or-resume with automatic retry on inactivity timeout.
 *
 * When the agent process is killed due to stdout inactivity, this
 * function automatically resumes the session (up to `maxAutoResumes`
 * times).  After that, the timeout error is returned to the caller so
 * the pipeline can prompt the user.
 */
export async function invokeOrResume(
  agent: AgentAdapter,
  savedSessionId: string | undefined,
  prompt: string,
  cwd: string,
  sink?: StreamSink,
  maxAutoResumes = 3,
): Promise<AgentResult> {
  const result = await invokeOrResumeOnce(
    agent,
    savedSessionId,
    prompt,
    cwd,
    sink,
  );
  return retryOnTimeout(agent, result, cwd, undefined, sink, maxAutoResumes);
}

/**
 * Single-shot invoke-or-resume (no auto-retry).
 */
async function invokeOrResumeOnce(
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
    // Non-recoverable errors and inactivity timeouts should be surfaced
    // immediately — the caller's retryOnTimeout handles timeout retries.
    // Falling through to fresh invoke would lose the session state.
    if (
      result.errorType === "cli_not_found" ||
      result.errorType === "execution_error" ||
      result.errorType === "config_parsing" ||
      result.errorType === "inactivity_timeout"
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
 * Send a follow-up prompt to the agent by resuming the session, with
 * automatic retry on inactivity timeout.
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
  maxAutoResumes = 3,
): Promise<AgentResult> {
  if (sessionId === undefined) {
    throw new Error(
      "Cannot send follow-up: no session ID from the previous turn. " +
        "The agent CLI may have failed to return a session.",
    );
  }
  const stream = agent.resume(sessionId, prompt, { cwd });
  if (sink) drainToSink(stream, sink);
  const result = await stream.result;
  return retryOnTimeout(agent, result, cwd, sessionId, sink, maxAutoResumes);
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
