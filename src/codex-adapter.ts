import type {
  AgentAdapter,
  AgentErrorType,
  AgentResult,
  AgentStream,
  InvokeOptions,
  TokenUsage,
} from "./agent.js";
import { JsonlLineTransformer } from "./agent.js";
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
 * `{"type":"turn.completed","usage":{"input_tokens":100,...}}`
 */
interface TurnCompletedEvent {
  type: "turn.completed";
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
  };
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
  | TurnCompletedEvent
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
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;

  for (const line of lines) {
    let event: CodexJsonEvent;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

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

    if (event.type === "turn.completed") {
      const e = event as TurnCompletedEvent;
      if (e.usage) {
        inputTokens += e.usage.input_tokens ?? 0;
        outputTokens += e.usage.output_tokens ?? 0;
        cachedInputTokens += e.usage.cached_input_tokens ?? 0;
      }
    }

    if (event.type === "turn.failed") {
      const e = event as TurnFailedEvent;
      failed = true;
      failMessage = e.error.message;
    }
  }

  const hasUsage = inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0;
  const usage: TokenUsage | undefined = hasUsage
    ? { inputTokens, outputTokens, cachedInputTokens }
    : undefined;

  if (failed) {
    return {
      sessionId,
      responseText: failMessage,
      status: "error",
      errorType: detectCodexError(failMessage),
      stderrText: "",
      usage,
    };
  }

  return {
    sessionId,
    responseText,
    status: "success",
    errorType: undefined,
    stderrText: "",
    usage,
  };
}

// ---------------------------------------------------------------------------
// Plain text parser (codex exec resume — does not support --json)
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

/**
 * Extract the total token count from the "tokens used\n<count>" footer
 * in Codex plain text output.  Returns undefined when the footer is
 * absent or the count is not a valid number.
 */
export function extractCodexPlainTextTokens(text: string): number | undefined {
  const marker = "\ntokens used\n";
  const idx = text.lastIndexOf(marker);
  if (idx === -1) return undefined;
  const rest = text.slice(idx + marker.length).trim();
  // The count may be on the first line only (ignore trailing content).
  const firstLine = rest.split("\n")[0].trim();
  const n = Number.parseInt(firstLine, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
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
    // Resume mode only reports a combined total ("tokens used"), not
    // split input/output.  Emitting it as inputTokens would be
    // misleading, so we omit usage entirely for this path.
  };
}

// ---------------------------------------------------------------------------
// ChunkTransformer — extract display text from Codex JSONL events
// ---------------------------------------------------------------------------

/**
 * Transforms raw Codex JSONL chunks into human-readable text for the
 * terminal UI.  Extracts `agent_message` text from `item.completed`
 * events.
 */
export class CodexStreamTransformer extends JsonlLineTransformer {
  protected extractTextFromEvent(event: unknown): string {
    const e = event as Record<string, unknown>;
    if (e.type !== "item.completed") return "";
    const item = e.item as Record<string, unknown> | undefined;
    if (item?.type !== "agent_message") return "";
    return (item.text as string) ?? "";
  }

  protected extractUsageFromEvent(
    event: unknown,
  ): import("./agent.js").TokenUsage | undefined {
    const e = event as Record<string, unknown>;
    if (e.type !== "turn.completed") return undefined;
    const u = (e as { usage?: Record<string, number> }).usage;
    if (!u) return undefined;
    const inputTokens = u.input_tokens ?? 0;
    const outputTokens = u.output_tokens ?? 0;
    const cachedInputTokens = u.cached_input_tokens ?? 0;
    if (inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0) {
      return { inputTokens, outputTokens, cachedInputTokens };
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Error detection
// ---------------------------------------------------------------------------

export function detectCodexError(text: string): AgentErrorType {
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
  if (lower.includes("unknown variant") || lower.includes("invalid value")) {
    return "config_parsing";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// CLI args builders
// ---------------------------------------------------------------------------

const CODEX_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

const VALID_CODEX_REASONING_EFFORTS: ReadonlySet<string> = new Set(
  CODEX_REASONING_EFFORTS,
);

/**
 * Validate that `value` is a supported Codex reasoning effort level.
 * Throws with a descriptive message when the value is unsupported.
 */
export function validateCodexReasoningEffort(
  value: string,
): CodexReasoningEffort {
  if (VALID_CODEX_REASONING_EFFORTS.has(value)) {
    return value as CodexReasoningEffort;
  }
  const supported = [...VALID_CODEX_REASONING_EFFORTS].join(", ");
  throw new Error(
    `Unsupported Codex reasoning effort "${value}". Supported values: ${supported}`,
  );
}

export interface CodexAdapterOptions {
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  inactivityTimeoutMs?: number;
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
  // Note: `codex exec resume` does not support --json; output is plain text.
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

/**
 * Wrap an AgentStream so that when `xhigh` is rejected by the CLI
 * (config_parsing error), the stream transparently retries with `high`.
 *
 * Both the async iterator and the result promise are wired through the
 * retry: the iterator first drains the failed attempt, then — on
 * fallback — continues yielding chunks from the retry stream so that
 * the pipeline UI keeps receiving output.
 */
function withXhighFallback(
  stream: AgentStream,
  retryFn: () => AgentStream,
): AgentStream {
  // Shared state: if the first attempt fails with config_parsing, the
  // retry stream is stored here so both the iterator and result can
  // reference it.
  let retryStream: AgentStream | undefined;

  const result = stream.result.then((r) => {
    if (r.status === "error" && r.errorType === "config_parsing") {
      retryStream = retryFn();
      return retryStream.result;
    }
    return r;
  });

  async function* chunks(): AsyncGenerator<string> {
    yield* stream;
    // After the first stream finishes, await the result to know whether
    // a fallback was triggered.
    await result;
    if (retryStream) {
      yield* retryStream;
    }
  }

  return {
    [Symbol.asyncIterator]: () => chunks(),
    child: stream.child,
    result,
  };
}

export function createCodexAdapter(
  opts: CodexAdapterOptions = {},
): AgentAdapter {
  const model = opts.model;
  const reasoningEffort = validateCodexReasoningEffort(
    opts.reasoningEffort ?? "high",
  );
  const inactivityTimeoutMs = opts.inactivityTimeoutMs;

  return {
    invoke(prompt, options?: InvokeOptions) {
      function makeTransformer(): CodexStreamTransformer {
        const t = new CodexStreamTransformer();
        if (options?.onUsage) t.onUsage = options.onUsage;
        return t;
      }
      const stream = spawnAgent({
        command: "codex",
        args: buildCodexInvokeArgs(prompt, { model, reasoningEffort }),
        cwd: options?.cwd,
        parseResult: parseCodexInvokeOutput,
        chunkTransformer: makeTransformer(),
        inactivityTimeoutMs,
      });
      if (reasoningEffort !== "xhigh") return stream;
      return withXhighFallback(stream, () =>
        spawnAgent({
          command: "codex",
          args: buildCodexInvokeArgs(prompt, {
            model,
            reasoningEffort: "high",
          }),
          cwd: options?.cwd,
          parseResult: parseCodexInvokeOutput,
          chunkTransformer: makeTransformer(),
          inactivityTimeoutMs,
        }),
      );
    },
    resume(sessionId, prompt, options?: InvokeOptions) {
      function parseResume(
        output: string,
        exitCode: number | null,
        stderr: string,
      ): AgentResult {
        const result = parseCodexPlainText(output, exitCode, stderr);
        // Preserve the input session ID when the plain text output
        // does not contain one (e.g. older CLI versions).
        if (result.sessionId === undefined) {
          result.sessionId = sessionId;
        }
        return result;
      }

      // codex exec resume outputs plain text, not JSONL.
      const stream = spawnAgent({
        command: "codex",
        args: buildCodexResumeArgs(sessionId, prompt, {
          model,
          reasoningEffort,
        }),
        cwd: options?.cwd,
        parseResult: parseResume,
        // No chunkTransformer for resume — plain text is already
        // human-readable and can go directly to the UI.
        inactivityTimeoutMs,
      });
      if (reasoningEffort !== "xhigh") return stream;
      return withXhighFallback(stream, () =>
        spawnAgent({
          command: "codex",
          args: buildCodexResumeArgs(sessionId, prompt, {
            model,
            reasoningEffort: "high",
          }),
          cwd: options?.cwd,
          parseResult: parseResume,
          inactivityTimeoutMs,
        }),
      );
    },
  };
}
