import type {
  AgentAdapter,
  AgentErrorType,
  AgentResult,
  InvokeOptions,
  TokenUsage,
} from "./agent.js";
import { JsonlLineTransformer } from "./agent.js";
import { spawnAgent } from "./spawn-agent.js";

// ---------------------------------------------------------------------------
// stream-json event types
// ---------------------------------------------------------------------------

/**
 * Subset of JSONL events emitted by
 * `claude -p --output-format stream-json --verbose` that we consume.
 *
 * With `--verbose`, each completed assistant turn emits an `assistant`
 * event containing the full message content.  The final `result` event
 * carries the aggregate response text and session metadata.
 */
export type ClaudeStreamEvent =
  | { type: "system"; subtype: "init"; session_id: string }
  | {
      type: "assistant";
      message: {
        content: { type: string; text?: string }[];
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      };
      session_id: string;
    }
  | {
      type: "result";
      subtype: string;
      session_id: string;
      is_error: boolean;
      result?: string;
      error?: string;
      total_cost_usd?: number;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    }
  | { type: string };

// ---------------------------------------------------------------------------
// JSONL parser (full output → AgentResult)
// ---------------------------------------------------------------------------

/**
 * Parse the full JSONL output from `--output-format stream-json --verbose`.
 *
 * We iterate through all lines looking for the `result` event (always
 * the last meaningful event).  Earlier events may also carry the
 * session ID (the `system/init` event).
 */
export function parseClaudeStreamJson(jsonl: string): AgentResult {
  const lines = jsonl
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let sessionId: string | undefined;
  let resultText = "";
  let isError = false;
  let subtype = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let hasAssistantUsage = false;

  for (const line of lines) {
    let event: ClaudeStreamEvent;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "system" && "session_id" in event) {
      const e = event as Extract<ClaudeStreamEvent, { type: "system" }>;
      sessionId ??= e.session_id;
    }

    if (event.type === "assistant" && "message" in event) {
      const e = event as Extract<ClaudeStreamEvent, { type: "assistant" }>;
      const u = e.message.usage;
      if (u) {
        hasAssistantUsage = true;
        inputTokens += u.input_tokens ?? 0;
        outputTokens += u.output_tokens ?? 0;
        cachedInputTokens +=
          (u.cache_read_input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0);
      }
    }

    if (event.type === "result") {
      const e = event as Extract<ClaudeStreamEvent, { type: "result" }>;
      sessionId = e.session_id || sessionId;
      resultText = e.result ?? e.error ?? "";
      isError = e.is_error;
      subtype = e.subtype;
      if (!hasAssistantUsage) {
        const u = e.usage;
        if (u) {
          inputTokens += u.input_tokens ?? 0;
          outputTokens += u.output_tokens ?? 0;
          cachedInputTokens +=
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0);
        }
      }
    }
  }

  const hasUsage = inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0;
  return {
    sessionId: sessionId || undefined,
    responseText: resultText,
    status: isError ? "error" : "success",
    errorType: isError ? claudeErrorType(subtype) : undefined,
    stderrText: "",
    usage: hasUsage
      ? { inputTokens, outputTokens, cachedInputTokens }
      : undefined,
  };
}

function claudeErrorType(subtype: string): AgentErrorType {
  switch (subtype) {
    case "error_max_turns":
      return "max_turns";
    case "error_during_execution":
      return "execution_error";
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// ChunkTransformer — extract display text from streaming events
// ---------------------------------------------------------------------------

/**
 * Transforms raw JSONL chunks into human-readable text for the terminal
 * UI.  Extracts text from `assistant` events (each completed model turn)
 * so the UI updates after every turn rather than waiting for the final
 * `result` event.
 */
export class ClaudeStreamTransformer extends JsonlLineTransformer {
  protected extractTextFromEvent(event: unknown): string {
    const e = event as Record<string, unknown>;
    if (e.type !== "assistant") return "";
    const msg = e.message as Record<string, unknown> | undefined;
    const content = msg?.content as
      | { type: string; text?: string }[]
      | undefined;
    if (!Array.isArray(content)) return "";
    let text = "";
    for (const block of content) {
      if (block.type === "text" && block.text) {
        text += block.text;
      }
    }
    return text;
  }

  protected extractUsageFromEvent(event: unknown): TokenUsage | undefined {
    const e = event as Record<string, unknown>;
    if (e.type === "assistant" && "message" in e) {
      const msg = e.message as Record<string, unknown> | undefined;
      const u = msg?.usage as Record<string, number> | undefined;
      if (!u) return undefined;
      const inputTokens = u.input_tokens ?? 0;
      const outputTokens = u.output_tokens ?? 0;
      const cachedInputTokens =
        (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0) {
        return { inputTokens, outputTokens, cachedInputTokens };
      }
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Adapter options + args builder
// ---------------------------------------------------------------------------

export type ClaudeEffortLevel = "low" | "medium" | "high" | "max";

export interface ClaudeAdapterOptions {
  model?: string;
  effortLevel?: ClaudeEffortLevel;
  contextWindow?: string;
  inactivityTimeoutMs?: number;
}

export function buildClaudeArgs(
  prompt: string,
  opts: {
    model?: string;
    effortLevel?: ClaudeEffortLevel;
    contextWindow?: string;
  },
  sessionId?: string,
): string[] {
  // --verbose is required for --output-format stream-json.
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (opts.model) {
    // Append context window variant as a bracketed suffix (e.g. opus[1m])
    // when the extended 1M window is selected.
    let modelId = opts.model;
    if (opts.contextWindow === "1m") {
      modelId = `${modelId}[1m]`;
    }
    args.push("--model", modelId);
  }
  args.push("--permission-mode", "bypassPermissions");
  if (opts.effortLevel) {
    args.push("--effort", opts.effortLevel);
  }
  if (sessionId) {
    args.push("--resume", sessionId);
  }
  return args;
}

// ---------------------------------------------------------------------------
// parseResult callback
// ---------------------------------------------------------------------------

function parseClaudeOutput(
  output: string,
  code: number | null,
  stderrText: string,
): AgentResult {
  if (code !== 0 && output.trim() === "") {
    return {
      sessionId: undefined,
      responseText: `claude exited with code ${code}`,
      status: "error",
      errorType: "unknown",
      stderrText,
    };
  }
  try {
    const result = parseClaudeStreamJson(output);
    // Non-zero exit overrides a parsed success — partial stream-json
    // output (e.g. no `result` event) can look successful to the JSONL
    // parser even though the process actually failed.
    if (code !== 0 && result.status === "success") {
      return {
        ...result,
        stderrText,
        status: "error",
        errorType: "unknown",
      };
    }
    return { ...result, stderrText };
  } catch {
    return {
      sessionId: undefined,
      responseText: output,
      status: "error",
      errorType: "unknown",
      stderrText,
    };
  }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function createClaudeAdapter(
  opts: ClaudeAdapterOptions = {},
): AgentAdapter {
  const model = opts.model;
  const effortLevel = opts.effortLevel;
  const contextWindow = opts.contextWindow;
  const inactivityTimeoutMs = opts.inactivityTimeoutMs;

  return {
    invoke(prompt, options?: InvokeOptions) {
      const transformer = new ClaudeStreamTransformer();
      if (options?.onUsage) transformer.onUsage = options.onUsage;
      return spawnAgent({
        command: "claude",
        args: buildClaudeArgs(prompt, {
          model,
          effortLevel,
          contextWindow,
        }),
        cwd: options?.cwd,
        parseResult: parseClaudeOutput,
        chunkTransformer: transformer,
        inactivityTimeoutMs,
      });
    },
    resume(sessionId, prompt, options?: InvokeOptions) {
      const transformer = new ClaudeStreamTransformer();
      if (options?.onUsage) transformer.onUsage = options.onUsage;
      return spawnAgent({
        command: "claude",
        args: buildClaudeArgs(
          prompt,
          { model, effortLevel, contextWindow },
          sessionId,
        ),
        cwd: options?.cwd,
        parseResult: parseClaudeOutput,
        chunkTransformer: transformer,
        inactivityTimeoutMs,
      });
    },
  };
}
