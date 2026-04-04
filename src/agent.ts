import type { ChildProcess } from "node:child_process";

export type AgentStatus = "success" | "error";

export type AgentErrorType =
  | "max_turns"
  | "execution_error"
  | "cli_not_found"
  | "config_parsing"
  | "inactivity_timeout"
  | "unknown";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface AgentResult {
  sessionId: string | undefined;
  responseText: string;
  status: AgentStatus;
  errorType: AgentErrorType | undefined;
  /** stderr output from the CLI process, useful for error diagnostics. */
  stderrText: string;
  /** Exit code of the CLI process, or null if the process was killed by a signal. */
  exitCode?: number | null;
  /** Signal that terminated the process (e.g. SIGTERM, SIGKILL), if any. */
  signal?: NodeJS.Signals | null;
  /** Token usage from the agent invocation, when available. */
  usage?: TokenUsage;
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
  /** Real-time usage callback, invoked as usage events stream in. */
  onUsage?: (usage: TokenUsage) => void;
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
  /** When set, called with token usage extracted from streaming events. */
  onUsage?: (usage: TokenUsage) => void;
}

/**
 * Base class for JSONL-based chunk transformers.  Handles line buffering
 * and JSON parsing; subclasses implement `extractTextFromEvent` to pick
 * out the display text for their specific event format.
 */
export abstract class JsonlLineTransformer implements ChunkTransformer {
  private buffer = "";
  onUsage?: (usage: TokenUsage) => void;

  push(raw: string): string {
    this.buffer += raw;
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop() ?? "";

    let text = "";
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        const extracted = this.extractTextFromEvent(parsed);
        if (extracted) text += `${extracted}\n`;
        if (this.onUsage) {
          const usage = this.extractUsageFromEvent(parsed);
          if (usage) this.onUsage(usage);
        }
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
      const parsed = JSON.parse(trimmed);
      const extracted = this.extractTextFromEvent(parsed);
      if (this.onUsage) {
        const usage = this.extractUsageFromEvent(parsed);
        if (usage) this.onUsage(usage);
      }
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

  /**
   * Given a parsed JSONL event, return token usage if the event carries
   * usage data, or `undefined` to skip.  Subclasses override this to
   * extract usage from their format-specific events.
   */
  protected extractUsageFromEvent(_event: unknown): TokenUsage | undefined {
    return undefined;
  }
}
