import type {
  AgentAdapter,
  AgentErrorType,
  AgentResult,
  InvokeOptions,
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

    if (event.type === "result") {
      const e = event as Extract<ClaudeStreamEvent, { type: "result" }>;
      sessionId = e.session_id || sessionId;
      resultText = e.result ?? e.error ?? "";
      isError = e.is_error;
      subtype = e.subtype;
    }
  }

  return {
    sessionId: sessionId || undefined,
    responseText: resultText,
    status: isError ? "error" : "success",
    errorType: isError ? claudeErrorType(subtype) : undefined,
    stderrText: "",
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
}

// ---------------------------------------------------------------------------
// Adapter options + args builder
// ---------------------------------------------------------------------------

export type ClaudePermissionMode = "auto" | "bypass";

export interface ClaudeAdapterOptions {
  model?: string;
  permissionMode?: ClaudePermissionMode;
  inactivityTimeoutMs?: number;
}

export function buildClaudeArgs(
  prompt: string,
  opts: { model?: string; permissionMode: ClaudePermissionMode },
  sessionId?: string,
): string[] {
  // --verbose is required for --output-format stream-json.
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (opts.model) {
    args.push("--model", opts.model);
  }
  if (opts.permissionMode === "bypass") {
    args.push("--permission-mode", "bypassPermissions");
  } else {
    args.push("--permission-mode", "auto");
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
  const permissionMode = opts.permissionMode ?? "auto";
  const inactivityTimeoutMs = opts.inactivityTimeoutMs;

  return {
    invoke(prompt, options?: InvokeOptions) {
      return spawnAgent({
        command: "claude",
        args: buildClaudeArgs(prompt, { model, permissionMode }),
        cwd: options?.cwd,
        parseResult: parseClaudeOutput,
        chunkTransformer: new ClaudeStreamTransformer(),
        inactivityTimeoutMs,
      });
    },
    resume(sessionId, prompt, options?: InvokeOptions) {
      return spawnAgent({
        command: "claude",
        args: buildClaudeArgs(prompt, { model, permissionMode }, sessionId),
        cwd: options?.cwd,
        parseResult: parseClaudeOutput,
        chunkTransformer: new ClaudeStreamTransformer(),
        inactivityTimeoutMs,
      });
    },
  };
}
