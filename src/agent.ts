import type { ChildProcess } from "node:child_process";

export type AgentStatus = "success" | "error";

export type AgentErrorType =
  | "max_turns"
  | "execution_error"
  | "cli_not_found"
  | "config_parsing"
  | "inactivity_timeout"
  | "unknown";

export interface AgentResult {
  sessionId: string | undefined;
  responseText: string;
  status: AgentStatus;
  errorType: AgentErrorType | undefined;
  /** stderr output from the CLI process, useful for error diagnostics. */
  stderrText: string;
}

export interface AgentStream {
  /** Async iterator that yields output chunks as they arrive. */
  [Symbol.asyncIterator](): AsyncIterator<string>;

  /**
   * Resolves when the process exits with the final structured result.
   * Consuming the iterator is optional; `result` always resolves.
   */
  result: Promise<AgentResult>;

  /** The underlying child process, exposed for cancellation. */
  child: ChildProcess;
}

export interface AgentAdapter {
  invoke(prompt: string, options?: InvokeOptions): AgentStream;
  resume(
    sessionId: string,
    prompt: string,
    options?: InvokeOptions,
  ): AgentStream;
}

export interface InvokeOptions {
  cwd?: string;
}

/**
 * Transforms raw stdout chunks into display-friendly text for the UI.
 *
 * Adapters provide implementations that parse format-specific output
 * (e.g. Claude stream-json JSONL, Codex JSONL) and extract human-readable
 * text.  Raw chunks are still collected separately for `parseResult`.
 */
export interface ChunkTransformer {
  /** Process a raw stdout chunk; return display-friendly text (may be ""). */
  push(raw: string): string;
  /** Flush any remaining buffered content at stream end. */
  flush(): string;
}

/**
 * Base class for JSONL-based chunk transformers.  Handles line buffering
 * and JSON parsing; subclasses implement `extractTextFromEvent` to pick
 * out the display text for their specific event format.
 */
export abstract class JsonlLineTransformer implements ChunkTransformer {
  private buffer = "";

  push(raw: string): string {
    this.buffer += raw;
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop() ?? "";

    let text = "";
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      try {
        const extracted = this.extractTextFromEvent(JSON.parse(trimmed));
        if (extracted) text += `${extracted}\n`;
      } catch {
        // Non-JSON line — ignore.
      }
    }
    return text;
  }

  flush(): string {
    const trimmed = this.buffer.trim();
    this.buffer = "";
    if (!trimmed) return "";
    try {
      const extracted = this.extractTextFromEvent(JSON.parse(trimmed));
      if (extracted) return `${extracted}\n`;
      return "";
    } catch {
      return "";
    }
  }

  /**
   * Given a parsed JSONL event, return the display-friendly text to emit
   * (or empty string to skip).
   */
  protected abstract extractTextFromEvent(event: unknown): string;
}
