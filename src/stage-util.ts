/**
 * Shared utilities for stage handlers — agent error mapping,
 * step-status-to-outcome conversion, and inactivity auto-resume.
 */

import type {
  AgentAdapter,
  AgentResult,
  AgentStream,
  TokenUsage,
} from "./agent.js";
import { t } from "./i18n/index.js";
import type { StageOutcome, StageResult } from "./pipeline.js";
import {
  type ParsedStep,
  parseStepStatus,
  parseVerdictKeyword,
} from "./step-parser.js";

/**
 * Callback that receives streaming output chunks from an agent process.
 */
export type StreamSink = (chunk: string) => void;

/**
 * Callback that receives the full prompt text before it is sent to the agent.
 * Used by the UI to display outgoing prompts in the agent's pane.
 */
export type PromptSink = (prompt: string) => void;

/**
 * Callback that receives token usage data after an agent invocation completes.
 * Used by the UI to display per-agent token consumption.
 */
export type UsageSink = (usage: TokenUsage) => void;

/**
 * Log full diagnostic details for an agent process failure so that
 * transient or hard-to-reproduce errors leave a durable trail.
 */
export function logAgentFailure(result: AgentResult, context?: string): void {
  const parts: string[] = ["Agent process failure"];
  if (context) parts[0] += ` ${context}`;
  if (result.errorType) parts.push(`errorType=${result.errorType}`);
  if (result.exitCode !== undefined && result.exitCode !== null)
    parts.push(`exitCode=${result.exitCode}`);
  if (result.signal) parts.push(`signal=${result.signal}`);
  if (result.stderrText) parts.push(`stderr=${result.stderrText.trim()}`);
  console.error(parts.join(" | "));
}

/**
 * Map an `AgentResult` with `status === "error"` to a `StageResult`.
 * The optional `context` string is included in the message for
 * diagnostics (e.g. "during self-check").
 */
export function mapAgentError(
  result: AgentResult,
  context?: string,
): StageResult {
  logAgentFailure(result, context);
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
  const detail = buildErrorDetail(result);
  return {
    outcome: "error",
    message: m["stageError.agentError"](during, detail),
  };
}

/**
 * Build an informative error detail string from an `AgentResult`.
 *
 * Combines stderr, exit code, and response text so the user gets
 * actionable information instead of just "unknown".
 */
export function buildErrorDetail(result: AgentResult): string {
  const parts: string[] = [];

  if (result.errorType) {
    parts.push(result.errorType);
  }

  if (result.stderrText) {
    parts.push(result.stderrText.trim());
  }

  if (result.signal) {
    parts.push(`signal ${result.signal}`);
  }

  if (result.exitCode !== undefined && result.exitCode !== null) {
    parts.push(`exit code ${result.exitCode}`);
  }

  const hasProcessDetails =
    !!result.stderrText?.trim() ||
    !!result.signal ||
    (result.exitCode !== undefined && result.exitCode !== null);
  if (!hasProcessDetails && result.responseText) {
    parts.push(result.responseText.trim());
  }

  if (parts.length === 0) {
    parts.push("unknown");
  }

  const [primary, ...rest] = parts;
  return rest.length > 0 ? `${primary} (${rest.join(", ")})` : primary;
}

/**
 * Convert a `ParsedStep` (from `parseStepStatus`) to a `StageOutcome`.
 *
 * By default every terminal keyword maps to `"completed"`.  Callers can
 * supply `overrides` to remap specific statuses — for example the
 * self-check stage maps the FIXED keyword to `"not_approved"` so the
 * pipeline loops.
 *
 * When `validKeywords` is provided, a parsed keyword that is not in the
 * set is rejected as `needs_clarification` with the valid set attached
 * to the result for scoped clarification prompts.
 */
export function mapParsedStepToResult(
  parsed: ParsedStep,
  responseText: string,
  overrides?: Partial<Record<ParsedStep["status"], StageOutcome>>,
  validKeywords?: readonly string[],
): StageResult {
  // Reject out-of-scope keywords when a valid set is provided.
  if (
    validKeywords &&
    validKeywords.length > 0 &&
    parsed.keyword !== undefined
  ) {
    const upper = validKeywords.map((k) => k.toUpperCase());
    if (!upper.includes(parsed.keyword.toUpperCase())) {
      return {
        outcome: "needs_clarification",
        message: responseText,
        validVerdicts: validKeywords,
      };
    }
  }

  const outcomeMap: Record<ParsedStep["status"], StageOutcome> = {
    completed: "completed",
    fixed: "completed",
    approved: "completed",
    not_approved: "not_approved",
    blocked: "blocked",
    ambiguous: "needs_clarification",
    ...overrides,
  };

  const result: StageResult = {
    outcome: outcomeMap[parsed.status],
    message: responseText,
  };

  // Attach valid keywords when the outcome is ambiguous so the pipeline
  // engine can build a scoped clarification prompt.
  if (result.outcome === "needs_clarification" && validKeywords) {
    result.validVerdicts = validKeywords;
  }

  return result;
}

/**
 * Drain the async iterator of a stream, forwarding chunks to a sink.
 *
 * Returns a promise that resolves when the iterator is fully consumed.
 * Callers should await this promise after `stream.result` to guarantee
 * all chunks have been delivered before injecting the next prompt.
 */
export function drainToSink(
  stream: AgentStream,
  sink: StreamSink,
): Promise<void> {
  return (async () => {
    try {
      for await (const chunk of stream) {
        sink(chunk);
      }
    } catch {
      // Sink errors must not become unhandled rejections.
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
  usageSink?: UsageSink,
): Promise<AgentResult> {
  let result = initial;
  let left = maxRetries;

  while (result.errorType === "inactivity_timeout" && left > 0) {
    const sid = result.sessionId ?? fallbackSessionId;
    if (!sid) break;
    left--;
    const stream = agent.resume(sid, DEFAULT_RESUME_PROMPT, {
      cwd,
      onUsage: usageSink,
    });
    const drained = sink ? drainToSink(stream, sink) : undefined;
    result = await stream.result;
    if (drained) await drained;
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
  usageSink?: UsageSink,
): Promise<AgentResult> {
  const result = await invokeOrResumeOnce(
    agent,
    savedSessionId,
    prompt,
    cwd,
    sink,
    usageSink,
  );
  return retryOnTimeout(
    agent,
    result,
    cwd,
    undefined,
    sink,
    maxAutoResumes,
    usageSink,
  );
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
  usageSink?: UsageSink,
): Promise<AgentResult> {
  const opts = { cwd, onUsage: usageSink };
  if (savedSessionId) {
    const stream = agent.resume(savedSessionId, prompt, opts);
    const drained = sink ? drainToSink(stream, sink) : undefined;
    const result = await stream.result;
    if (drained) await drained;
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
  const stream = agent.invoke(prompt, opts);
  const drained = sink ? drainToSink(stream, sink) : undefined;
  const result = await stream.result;
  if (drained) await drained;
  return result;
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
  usageSink?: UsageSink,
): Promise<AgentResult> {
  if (sessionId === undefined) {
    throw new Error(
      "Cannot send follow-up: no session ID from the previous turn. " +
        "The agent CLI may have failed to return a session.",
    );
  }
  const stream = agent.resume(sessionId, prompt, {
    cwd,
    onUsage: usageSink,
  });
  const drained = sink ? drainToSink(stream, sink) : undefined;
  const result = await stream.result;
  if (drained) await drained;
  return retryOnTimeout(
    agent,
    result,
    cwd,
    sessionId,
    sink,
    maxAutoResumes,
    usageSink,
  );
}

/**
 * Convenience: parse response text and convert to a `StageResult` in one
 * call.
 *
 * When `validKeywords` is provided, the strict verdict parser is used:
 * the response must contain exactly one valid keyword with no extra
 * commentary.  Responses with multiple valid keywords, out-of-scope
 * keywords, or significant extra text are rejected as
 * `needs_clarification`.
 */
export function mapResponseToResult(
  responseText: string,
  overrides?: Partial<Record<ParsedStep["status"], StageOutcome>>,
  validKeywords?: readonly string[],
): StageResult {
  if (validKeywords && validKeywords.length > 0) {
    const verdict = parseVerdictKeyword(responseText, validKeywords);
    if (verdict.keyword === undefined) {
      return {
        outcome: "needs_clarification",
        message: responseText,
        validVerdicts: validKeywords,
      };
    }
    // Feed the matched keyword through parseStepStatus for status mapping.
    return mapParsedStepToResult(
      parseStepStatus(verdict.keyword),
      responseText,
      overrides,
      validKeywords,
    );
  }
  return mapParsedStepToResult(
    parseStepStatus(responseText),
    responseText,
    overrides,
    validKeywords,
  );
}

/**
 * Build instructions for keeping all forms of project documentation
 * consistent with code changes.
 *
 * Included in prompts at any stage where the author agent may be
 * modifying code: Stage 2 self-check, Stage 4 CI fix, and Stage 6
 * review response.  Stage 7 post-squash CI fix reuses the Stage 4
 * prompt and is covered transitively.
 *
 * The screenshot paragraph is scoped to manuals and documentation
 * site pages only — README hero images and CHANGELOG entries do
 * not typically embed behavior-tracking screenshots, so listing
 * them in the screenshot clause would be noise.
 */
export function buildDocConsistencyInstructions(indent = ""): string {
  const lines = [
    `If your changes affect documentation, update it accordingly —`,
    `code comments, inline API docs (JSDoc/TSDoc/docstrings), README`,
    `files, CHANGELOG entries, and any user-facing manuals, guides,`,
    `or tutorials the project maintains.  If the project uses a`,
    `documentation site generator (MkDocs/Sphinx/Docusaurus/mdBook/`,
    `etc.), update the corresponding source pages — not just the`,
    `README.  If the project keeps a CHANGELOG (e.g. Keep a Changelog`,
    `format), add an appropriate entry.`,
    ``,
    `If a manual or documentation site page requires a screenshot,`,
    `capture a real one by starting the application and opening a`,
    `browser — do not use placeholders.  If your code changes`,
    `affect the visual output shown in existing manual screenshots,`,
    `retake them as part of the doc update.`,
  ];
  if (!indent) return lines.join("\n");
  return lines
    .map((line) => (line === "" ? "" : `${indent}${line}`))
    .join("\n");
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
 *
 * When `validKeywords` is provided, the strict verdict parser is used:
 * the response must contain exactly one valid keyword with no extra
 * commentary.
 */
export function mapFixOrDoneResponse(
  responseText: string,
  validKeywords?: readonly string[],
): StageResult {
  if (validKeywords && validKeywords.length > 0) {
    const verdict = parseVerdictKeyword(responseText, validKeywords);
    if (verdict.keyword === undefined) {
      return {
        outcome: "needs_clarification",
        message: responseText,
        validVerdicts: validKeywords,
      };
    }
    // Feed the matched keyword through parseStepStatus for status mapping.
    const parsed = parseStepStatus(verdict.keyword);
    if (parsed.status === "fixed" && parsed.keyword === "FIXED") {
      return mapParsedStepToResult(
        parsed,
        responseText,
        { fixed: "not_approved" },
        validKeywords,
      );
    }
    return mapParsedStepToResult(
      parsed,
      responseText,
      undefined,
      validKeywords,
    );
  }

  const parsed = parseStepStatus(responseText);
  if (parsed.status === "fixed" && parsed.keyword === "FIXED") {
    return mapParsedStepToResult(
      parsed,
      responseText,
      { fixed: "not_approved" },
      validKeywords,
    );
  }
  return mapParsedStepToResult(parsed, responseText, undefined, validKeywords);
}
