import type { ChildProcess } from "node:child_process";

export type AgentStatus = "success" | "error";

export type AgentErrorType =
  | "max_turns"
  | "execution_error"
  | "cli_not_found"
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
