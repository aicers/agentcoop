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

type CodexTurnTerminalEvent =
  | { type: "turn.completed" }
  | { type: "turn.failed"; message: string };

interface CodexBanner {
  bannerText: string;
  bodyStart: number;
}

interface CodexParsedResult extends AgentResult {
  sawStructuredJson?: boolean;
}

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
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let turnTerminalEvent: CodexTurnTerminalEvent | undefined;
  let pendingErrorMessage: string | undefined;

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
      turnTerminalEvent = { type: "turn.completed" };
      pendingErrorMessage = undefined;
    }

    if (event.type === "turn.failed") {
      const e = event as TurnFailedEvent;
      turnTerminalEvent = { type: "turn.failed", message: e.error.message };
      pendingErrorMessage = undefined;
    }

    if (event.type === "error" && turnTerminalEvent === undefined) {
      const e = event as ErrorEvent;
      pendingErrorMessage = e.message;
    }
  }

  const hasUsage = inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0;
  const usage: TokenUsage | undefined = hasUsage
    ? { inputTokens, outputTokens, cachedInputTokens }
    : undefined;

  if (turnTerminalEvent?.type === "turn.failed") {
    return {
      sessionId,
      responseText: turnTerminalEvent.message,
      status: "error",
      errorType: detectCodexError(turnTerminalEvent.message),
      stderrText: "",
      usage,
    };
  }

  if (pendingErrorMessage !== undefined) {
    return {
      sessionId,
      responseText: pendingErrorMessage,
      status: "error",
      errorType: detectCodexError(pendingErrorMessage),
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

function hasStructuredCodexJsonEvent(output: string): boolean {
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;

    try {
      const event = JSON.parse(line) as { type?: unknown };
      if (typeof event.type === "string") {
        return true;
      }
    } catch {
      // Ignore non-JSON lines; resume fallback detection only cares
      // whether the CLI produced any structured JSON events at all.
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Plain text parser (codex exec resume fallback for older CLI versions)
// ---------------------------------------------------------------------------

function extractCodexBanner(text: string): CodexBanner | undefined {
  const trimmed = text.trimStart();
  const leadingWhitespaceLength = text.length - trimmed.length;
  const bannerMatch =
    /^OpenAI Codex[^\n]*\n--------\n[\s\S]*?\n--------(?:\n|$)/.exec(trimmed);

  if (!bannerMatch) return undefined;

  return {
    bannerText: bannerMatch[0].trimEnd(),
    bodyStart: leadingWhitespaceLength + bannerMatch[0].length,
  };
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const trimmed = [...lines];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1]?.trim() === "") {
    trimmed.pop();
  }
  return trimmed;
}

function parseTrailingIntegerLine(line: string): number | undefined {
  const trimmed = line.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function stripTrailingTokenFooter(lines: string[]): string[] {
  const trimmed = trimTrailingBlankLines(lines);
  if (trimmed.length < 2) return trimmed;

  const tokenCount = parseTrailingIntegerLine(
    trimmed[trimmed.length - 1] ?? "",
  );
  if (
    trimmed[trimmed.length - 2] === "tokens used" &&
    tokenCount !== undefined
  ) {
    return trimmed.slice(0, -2);
  }

  return trimmed;
}

function extractBannerStructuredResumeResponse(
  text: string,
): string | undefined {
  const banner = extractCodexBanner(text);
  if (!banner) return undefined;

  const bodyLines = stripTrailingTokenFooter(
    text.slice(banner.bodyStart).split("\n"),
  );
  if (bodyLines[0] !== "user") return undefined;

  const assistantMarkerIndex = bodyLines.indexOf("codex", 1);
  if (assistantMarkerIndex === -1) return undefined;

  return bodyLines
    .slice(assistantMarkerIndex + 1)
    .join("\n")
    .trim();
}

function extractBareResumeResponse(text: string): string | undefined {
  const bodyLines = stripTrailingTokenFooter(text.split("\n"));
  if (bodyLines[0] !== "codex") return undefined;
  return bodyLines.slice(1).join("\n").trim();
}

function extractPromptAwareResumeResponse(
  text: string,
  expectedPrompt: string,
): string | undefined {
  const banner = extractCodexBanner(text);
  if (!banner) return undefined;

  const body = stripTrailingTokenFooter(
    text.slice(banner.bodyStart).split("\n"),
  );
  const bodyText = body.join("\n");
  const prefix = `user\n${expectedPrompt}\ncodex`;

  if (!bodyText.startsWith(prefix)) return undefined;

  const rest = bodyText.slice(prefix.length);
  if (rest === "") return "";
  if (!rest.startsWith("\n")) return undefined;
  return rest.slice(1).trim();
}

/**
 * Extract the assistant response from `codex exec resume` plain text output.
 * When `expectedPrompt` is provided, it is used to disambiguate prompt-side
 * marker lines from the real assistant boundary.
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
 * We prefer the validated banner boundary and only treat a
 * `tokens used` footer as structural when it is the real trailing
 * footer. This avoids misparsing assistant responses that contain
 * marker-like lines such as standalone `codex` or `tokens used`.
 *
 * When the original resume prompt is known, pass it as
 * `expectedPrompt` so the parser can disambiguate prompt-side marker
 * lines from the real assistant boundary.
 */
export function extractCodexResumeResponse(
  text: string,
  expectedPrompt?: string,
): string {
  return (
    (expectedPrompt
      ? extractPromptAwareResumeResponse(text, expectedPrompt)
      : undefined) ??
    extractBannerStructuredResumeResponse(text) ??
    extractBareResumeResponse(text) ??
    text.trim()
  );
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
  const banner = extractCodexBanner(text);
  if (!banner) return undefined;
  const match = /^session id:\s*(\S+)/m.exec(banner.bannerText);
  return match?.[1];
}

/**
 * Extract the total token count from the "tokens used\n<count>" footer
 * in Codex plain text output.  Returns undefined when the footer is
 * absent or the count is not a valid number.
 */
export function extractCodexPlainTextTokens(text: string): number | undefined {
  const lines = trimTrailingBlankLines(text.split("\n"));
  if (lines.length < 2 || lines[lines.length - 2] !== "tokens used") {
    return undefined;
  }

  const n = parseTrailingIntegerLine(lines[lines.length - 1] ?? "");
  return n !== undefined && n > 0 ? n : undefined;
}

export function parseCodexPlainText(
  text: string,
  exitCode: number | null,
  stderrText: string,
  expectedPrompt?: string,
): AgentResult {
  const failed = exitCode !== 0;
  const responseText = failed
    ? text.trim()
    : extractCodexResumeResponse(text, expectedPrompt);
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

export function buildCodexInvokeArgs(opts: {
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
}): string[] {
  const args = [
    "exec",
    "-s",
    "danger-full-access",
    "--json",
    "-c",
    "approval_policy=never",
  ];
  if (opts.model) {
    args.push("-m", opts.model);
  }
  if (opts.reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${opts.reasoningEffort}`);
  }
  args.push("-");
  return args;
}

export function buildCodexResumeArgs(
  sessionId: string,
  opts: { model?: string; reasoningEffort?: CodexReasoningEffort },
): string[] {
  const args = [
    "exec",
    "resume",
    "--json",
    "-c",
    "approval_policy=never",
    "-c",
    "sandbox_mode=danger-full-access",
  ];
  if (opts.model) {
    args.push("-c", `model="${opts.model}"`);
  }
  if (opts.reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${opts.reasoningEffort}`);
  }
  args.push(sessionId, "-");
  return args;
}

/**
 * @internal Legacy compatibility path for older Codex CLIs that reject
 * `codex exec resume --json`.
 */
export function buildCodexPlainTextResumeArgs(
  sessionId: string,
  opts: { model?: string; reasoningEffort?: CodexReasoningEffort },
): string[] {
  const args = [
    "exec",
    "resume",
    "-c",
    "approval_policy=never",
    "-c",
    "sandbox_mode=danger-full-access",
  ];
  if (opts.model) {
    args.push("-c", `model="${opts.model}"`);
  }
  if (opts.reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${opts.reasoningEffort}`);
  }
  args.push(sessionId, "-");
  return args;
}

// ---------------------------------------------------------------------------
// parseResult callbacks
// ---------------------------------------------------------------------------

function parseCodexInvokeOutput(
  output: string,
  code: number | null,
  stderrText: string,
): CodexParsedResult {
  const sawStructuredJson = hasStructuredCodexJsonEvent(output);

  try {
    const parsed = parseCodexJsonl(output);
    const result: CodexParsedResult = {
      ...parsed,
      stderrText,
      sawStructuredJson,
    };
    if (code !== 0 && result.status === "success") {
      const fallbackResponseText =
        result.responseText ||
        output.trim() ||
        stderrText.trim() ||
        `codex exited with code ${code}`;
      return {
        ...result,
        responseText: fallbackResponseText,
        status: "error",
        errorType: detectCodexError(
          `${fallbackResponseText}\n${output}\n${stderrText}`,
        ),
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
      sawStructuredJson,
    };
  }
}

function parseCodexResumeJsonOutput(
  sessionId: string,
  output: string,
  code: number | null,
  stderrText: string,
): CodexParsedResult {
  const result = parseCodexInvokeOutput(output, code, stderrText);
  if (result.sessionId === undefined) {
    result.sessionId = sessionId;
  }
  return result;
}

function parseCodexResumePlainTextOutput(
  sessionId: string,
  prompt: string,
  output: string,
  exitCode: number | null,
  stderrText: string,
): AgentResult {
  const result = parseCodexPlainText(output, exitCode, stderrText, prompt);
  if (result.sessionId === undefined) {
    result.sessionId = sessionId;
  }
  return result;
}

function withConditionalFallback<
  TPrimary extends AgentResult,
  TFallback extends AgentResult = TPrimary,
>(
  stream: AgentStream<TPrimary>,
  shouldRetry: (result: TPrimary) => boolean,
  retryFn: () => AgentStream<TFallback>,
): AgentStream<TPrimary | TFallback>;
function withConditionalFallback<
  TPrimary extends AgentResult,
  TFallback extends AgentResult,
>(
  stream: AgentStream<TPrimary>,
  shouldRetry: (result: TPrimary) => boolean,
  retryFn: () => AgentStream<TFallback>,
): AgentStream<TPrimary | TFallback> {
  let retryStream: AgentStream<TFallback> | undefined;
  let iterated = false;

  function ensureRetryStream(): AgentStream<TFallback> {
    retryStream ??= retryFn();
    return retryStream;
  }

  const result: Promise<TPrimary | TFallback> = (async () => {
    const firstResult = await stream.result;
    if (shouldRetry(firstResult)) {
      return ensureRetryStream().result;
    }
    return firstResult;
  })();

  async function* chunks(): AsyncGenerator<string> {
    yield* stream;
    const firstResult = await stream.result;
    if (shouldRetry(firstResult)) {
      yield* ensureRetryStream();
    }
  }

  return {
    [Symbol.asyncIterator]() {
      if (iterated) {
        throw new Error("AgentStream can only be iterated once");
      }
      iterated = true;
      return chunks();
    },
    get child() {
      return retryStream?.child ?? stream.child;
    },
    result,
  };
}

function hasUnsupportedJsonResumeArgumentLine(text: string): boolean {
  for (const rawLine of text.split("\n")) {
    const line = rawLine.toLowerCase();
    if (!line.includes("--json")) continue;

    if (
      line.includes("unexpected argument") ||
      line.includes("unexpected option") ||
      line.includes("unexpected flag") ||
      line.includes("unknown argument") ||
      line.includes("unknown option") ||
      line.includes("unknown flag") ||
      line.includes("unrecognized argument") ||
      line.includes("unrecognized option") ||
      line.includes("unrecognized flag") ||
      line.includes("wasn't expected")
    ) {
      return true;
    }
  }

  return false;
}

function isUnsupportedJsonResumeFailure(result: CodexParsedResult): boolean {
  if (result.status !== "error") return false;
  if (result.sawStructuredJson) return false;

  return hasUnsupportedJsonResumeArgumentLine(
    `${result.responseText}\n${result.stderrText}`,
  );
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
 *
 * The `child` property is a getter that always returns the currently
 * active child process, so that cancellation (Ctrl+C) kills the right
 * process even when the fallback retry is running.
 */
export function withXhighFallback<TResult extends AgentResult>(
  stream: AgentStream<TResult>,
  retryFn: () => AgentStream<TResult>,
): AgentStream<TResult> {
  return withConditionalFallback<TResult, TResult>(
    stream,
    (r) => r.status === "error" && r.errorType === "config_parsing",
    retryFn,
  );
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
        args: buildCodexInvokeArgs({ model, reasoningEffort }),
        cwd: options?.cwd,
        parseResult: parseCodexInvokeOutput,
        chunkTransformer: makeTransformer(),
        inactivityTimeoutMs,
        stdin: prompt,
      });
      if (reasoningEffort !== "xhigh") return stream;
      return withXhighFallback(stream, () =>
        spawnAgent({
          command: "codex",
          args: buildCodexInvokeArgs({
            model,
            reasoningEffort: "high",
          }),
          cwd: options?.cwd,
          parseResult: parseCodexInvokeOutput,
          chunkTransformer: makeTransformer(),
          inactivityTimeoutMs,
          stdin: prompt,
        }),
      );
    },
    resume(sessionId, prompt, options?: InvokeOptions) {
      function makeTransformer(): CodexStreamTransformer {
        const t = new CodexStreamTransformer();
        if (options?.onUsage) t.onUsage = options.onUsage;
        return t;
      }

      function spawnJsonResumeAttempt(
        retryReasoningEffort: CodexReasoningEffort,
      ): AgentStream<CodexParsedResult> {
        return spawnAgent({
          command: "codex",
          args: buildCodexResumeArgs(sessionId, {
            model,
            reasoningEffort: retryReasoningEffort,
          }),
          cwd: options?.cwd,
          parseResult: (output, exitCode, stderrText) =>
            parseCodexResumeJsonOutput(sessionId, output, exitCode, stderrText),
          chunkTransformer: makeTransformer(),
          inactivityTimeoutMs,
          stdin: prompt,
        });
      }

      function spawnPlainTextResumeAttempt(
        retryReasoningEffort: CodexReasoningEffort,
      ): AgentStream {
        return spawnAgent({
          command: "codex",
          args: buildCodexPlainTextResumeArgs(sessionId, {
            model,
            reasoningEffort: retryReasoningEffort,
          }),
          cwd: options?.cwd,
          parseResult: (output, exitCode, stderrText) =>
            parseCodexResumePlainTextOutput(
              sessionId,
              prompt,
              output,
              exitCode,
              stderrText,
            ),
          inactivityTimeoutMs,
          stdin: prompt,
        });
      }

      function withReasoningFallback<TResult extends AgentResult>(
        spawnAttempt: (
          retryReasoningEffort: CodexReasoningEffort,
        ) => AgentStream<TResult>,
        retryReasoningEffort: CodexReasoningEffort,
      ): AgentStream<TResult> {
        const stream = spawnAttempt(retryReasoningEffort);
        if (retryReasoningEffort !== "xhigh") return stream;
        return withXhighFallback(stream, () => spawnAttempt("high"));
      }

      const jsonStream = withReasoningFallback(
        spawnJsonResumeAttempt,
        reasoningEffort,
      );

      return withConditionalFallback(
        jsonStream,
        isUnsupportedJsonResumeFailure,
        // Keep transport fallback separate from reasoning fallback. Very old
        // CLIs can reject `--json` and `xhigh` independently, so the
        // plain-text retry re-probes the configured effort instead of
        // assuming the JSON path already established the final supported
        // reasoning level.
        () =>
          withReasoningFallback(spawnPlainTextResumeAttempt, reasoningEffort),
      );
    },
  };
}
