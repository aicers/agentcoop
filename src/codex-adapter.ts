import type {
  AgentAdapter,
  AgentErrorType,
  AgentResult,
  InvokeOptions,
} from "./agent.js";
import { spawnAgent } from "./spawn-agent.js";

// ---------------------------------------------------------------------------
// JSONL event types emitted by `codex exec --json`
// ---------------------------------------------------------------------------

/**
 * `{"type":"thread.started","thread_id":"UUID"}`
 */
interface ThreadStartedEvent {
  type: "thread.started";
  thread_id: string;
}

/**
 * `{"type":"item.completed","item":{"id":"item_N","type":"agent_message"|"reasoning","text":"..."}}`
 */
interface ItemCompletedEvent {
  type: "item.completed";
  item: { id: string; type: string; text: string };
}

/**
 * `{"type":"turn.failed","error":{"message":"..."}}`
 */
interface TurnFailedEvent {
  type: "turn.failed";
  error: { message: string };
}

/**
 * `{"type":"error","message":"..."}`
 */
interface ErrorEvent {
  type: "error";
  message: string;
}

export type CodexJsonEvent =
  | ThreadStartedEvent
  | ItemCompletedEvent
  | TurnFailedEvent
  | ErrorEvent
  | { type: string };

// ---------------------------------------------------------------------------
// JSONL parser (codex exec --json)
// ---------------------------------------------------------------------------

export function parseCodexJsonl(jsonl: string): AgentResult {
  const lines = jsonl
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let sessionId: string | undefined;
  let responseText = "";
  let failed = false;
  let failMessage = "";

  for (const line of lines) {
    const event: CodexJsonEvent = JSON.parse(line);

    if (event.type === "thread.started") {
      const e = event as ThreadStartedEvent;
      if (!sessionId) {
        sessionId = e.thread_id;
      }
    }

    if (event.type === "item.completed") {
      const e = event as ItemCompletedEvent;
      if (e.item.type === "agent_message") {
        responseText = e.item.text;
      }
    }

    if (event.type === "turn.failed") {
      const e = event as TurnFailedEvent;
      failed = true;
      failMessage = e.error.message;
    }
  }

  if (failed) {
    return {
      sessionId,
      responseText: failMessage,
      status: "error",
      errorType: detectCodexError(failMessage),
      stderrText: "",
    };
  }

  return {
    sessionId,
    responseText,
    status: "success",
    errorType: undefined,
    stderrText: "",
  };
}

// ---------------------------------------------------------------------------
// Plain text parser (codex exec resume)
// ---------------------------------------------------------------------------

/**
 * Extract the assistant response from `codex exec resume` plain text output.
 *
 * The output looks like:
 * ```
 * OpenAI Codex v0.46.0 (research preview)
 * --------
 * workdir: ...
 * model: ...
 * ...
 * session id: UUID
 * --------
 * user
 * <prompt>
 * codex
 * <response>
 * tokens used
 * <count>
 * ```
 *
 * We extract the text between the last "codex\n" marker and the
 * trailing "tokens used\n" footer.
 */
export function extractCodexResumeResponse(text: string): string {
  const codexMarker = "\ncodex\n";
  const footerMarker = "\ntokens used\n";

  const codexIdx = text.lastIndexOf(codexMarker);
  if (codexIdx === -1) {
    // Fallback: no recognizable structure, return trimmed text.
    return text.trim();
  }

  const start = codexIdx + codexMarker.length;
  const footerIdx = text.indexOf(footerMarker, start);
  const end = footerIdx === -1 ? text.length : footerIdx;

  return text.slice(start, end).trim();
}

/**
 * Extract the session ID from `codex exec resume` plain text banner.
 *
 * The real Codex banner always looks like:
 * ```
 * OpenAI Codex v0.46.0 (research preview)
 * --------
 * ...key: value lines including session id...
 * --------
 * ```
 *
 * We verify the `OpenAI Codex` header precedes the first `--------`
 * separator so that separator pairs appearing in the assistant's
 * response body are never mistaken for the banner.  Returns
 * `undefined` when the banner is absent or does not contain a
 * `session id:` line.
 */
export function extractSessionId(text: string): string | undefined {
  const sep = "--------";
  const first = text.indexOf(sep);
  if (first === -1) return undefined;

  // The real Codex banner always starts the output.  Reject when the
  // header is missing so that response body content is never mistaken
  // for the banner.
  if (!text.trimStart().startsWith("OpenAI Codex")) return undefined;

  const second = text.indexOf(sep, first + sep.length);
  if (second === -1) return undefined;
  const banner = text.slice(first, second + sep.length);
  const match = /^session id:\s*(\S+)/m.exec(banner);
  return match?.[1];
}

export function parseCodexPlainText(
  text: string,
  exitCode: number | null,
  stderrText: string,
): AgentResult {
  const failed = exitCode !== 0;
  const responseText = failed ? text.trim() : extractCodexResumeResponse(text);
  let errorType: AgentErrorType | undefined;
  if (failed) {
    errorType = detectCodexError(text + stderrText);
  }
  return {
    sessionId: extractSessionId(text),
    responseText,
    status: failed ? "error" : "success",
    errorType,
    stderrText,
  };
}

function detectCodexError(text: string): AgentErrorType {
  const lower = text.toLowerCase();
  if (lower.includes("max turns") || lower.includes("turn limit")) {
    return "max_turns";
  }
  if (
    lower.includes("error during execution") ||
    lower.includes("execution error")
  ) {
    return "execution_error";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// CLI args builders
// ---------------------------------------------------------------------------

export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface CodexAdapterOptions {
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
}

export function buildCodexInvokeArgs(
  prompt: string,
  opts: { model?: string; reasoningEffort?: CodexReasoningEffort },
): string[] {
  const args = ["exec", "-s", "danger-full-access", "--json"];
  if (opts.model) {
    args.push("-m", opts.model);
  }
  if (opts.reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${opts.reasoningEffort}`);
  }
  args.push(prompt);
  return args;
}

export function buildCodexResumeArgs(
  sessionId: string,
  prompt: string,
  opts: { model?: string; reasoningEffort?: CodexReasoningEffort },
): string[] {
  const args = ["exec", "resume", "-c", "sandbox_mode=danger-full-access"];
  if (opts.model) {
    args.push("-c", `model="${opts.model}"`);
  }
  if (opts.reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${opts.reasoningEffort}`);
  }
  args.push(sessionId, prompt);
  return args;
}

// ---------------------------------------------------------------------------
// parseResult callbacks
// ---------------------------------------------------------------------------

function parseCodexInvokeOutput(
  output: string,
  code: number | null,
  stderrText: string,
): AgentResult {
  try {
    const parsed = parseCodexJsonl(output);
    const result = { ...parsed, stderrText };
    if (code !== 0 && result.status === "success") {
      return {
        ...result,
        status: "error",
        errorType: detectCodexError(output + stderrText),
      };
    }
    return result;
  } catch {
    return {
      sessionId: undefined,
      responseText: output,
      status: code === 0 ? "success" : "error",
      errorType: code === 0 ? undefined : "unknown",
      stderrText,
    };
  }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function createCodexAdapter(
  opts: CodexAdapterOptions = {},
): AgentAdapter {
  const model = opts.model;
  const reasoningEffort = opts.reasoningEffort ?? "high";

  return {
    invoke(prompt, options?: InvokeOptions) {
      return spawnAgent({
        command: "codex",
        args: buildCodexInvokeArgs(prompt, { model, reasoningEffort }),
        cwd: options?.cwd,
        parseResult: parseCodexInvokeOutput,
      });
    },
    resume(sessionId, prompt, options?: InvokeOptions) {
      return spawnAgent({
        command: "codex",
        args: buildCodexResumeArgs(sessionId, prompt, {
          model,
          reasoningEffort,
        }),
        cwd: options?.cwd,
        parseResult(output, exitCode, stderr) {
          const result = parseCodexPlainText(output, exitCode, stderr);
          // Preserve the input session ID when the plain text output
          // does not contain one (e.g. older CLI versions).
          if (result.sessionId === undefined) {
            result.sessionId = sessionId;
          }
          return result;
        },
      });
    },
  };
}
