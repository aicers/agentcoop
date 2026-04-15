import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import EventEmitter from "node:events";
import type { AgentResult, AgentStream, ChunkTransformer } from "./agent.js";

export interface SpawnAgentOptions {
  command: string;
  args: string[];
  cwd?: string;
  parseResult: (
    output: string,
    exitCode: number | null,
    stderrText: string,
  ) => AgentResult;
  /**
   * When provided, the async iterator yields transformed (display-friendly)
   * text instead of raw stdout chunks.  Raw chunks are still collected for
   * `parseResult`.
   */
  chunkTransformer?: ChunkTransformer;
  /**
   * Kill the child process if stdout is silent for this many milliseconds.
   * Omit or pass 0 to disable.
   */
  inactivityTimeoutMs?: number;
  /**
   * When provided, this text is written to the child's stdin and the
   * stream is closed.  This avoids placing large prompts on the command
   * line where they can hit the OS `ARG_MAX` limit.
   */
  stdin?: string;
}

export function spawnAgent(opts: SpawnAgentOptions): AgentStream {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    // spawn() can throw synchronously for errors like E2BIG (argument
    // list too long) or EACCES.  Convert these into a structured result
    // so callers never see an unhandled exception.
    const errno = (err as NodeJS.ErrnoException).code;
    const errorResult: AgentResult =
      errno === "ENOENT"
        ? {
            sessionId: undefined,
            responseText: `${opts.command} CLI not found`,
            status: "error",
            errorType: "cli_not_found",
            stderrText: "",
          }
        : {
            sessionId: undefined,
            responseText: (err as Error).message,
            status: "error",
            errorType: "execution_error",
            stderrText: "",
          };
    const stubChild = new EventEmitter() as ChildProcess;
    stubChild.kill = () => false;
    return {
      async *[Symbol.asyncIterator]() {},
      result: Promise.resolve(errorResult),
      child: stubChild,
    };
  }

  // Write prompt to stdin when provided, avoiding ARG_MAX limits.
  if (opts.stdin != null) {
    child.stdin?.on("error", () => {
      // EPIPE means the child closed its stdin before we finished
      // writing — harmless.  Other errors (e.g. ECONNRESET) will
      // surface as a non-zero exit code from the child, which the
      // `close` handler resolves as a structured AgentResult.
      // Throwing from an event callback would bypass structured error
      // handling and produce an uncaught exception.
    });
    child.stdin?.end(opts.stdin);
  } else {
    child.stdin?.end();
  }

  const { stdout, stderr } = child;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const transformer = opts.chunkTransformer;

  // Async queue: data listener is the single consumer of the stdout
  // stream.  It pushes to stdoutChunks (for the result promise) and to
  // chunkQueue (for the async iterator).  This avoids the conflict
  // between consuming a readable via both `data` events and
  // `for await`.
  const chunkQueue: string[] = [];
  let chunkResolve: (() => void) | null = null;
  let streamDone = false;

  // Inactivity timeout state.
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  function resetInactivityTimer(): void {
    if (!opts.inactivityTimeoutMs) return;
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.inactivityTimeoutMs);
  }

  // Start the timer immediately so silence from the very beginning is
  // caught.
  resetInactivityTimer();

  stdout?.on("data", (data: Buffer) => {
    const text = data.toString();
    stdoutChunks.push(text);

    resetInactivityTimer();

    if (transformer) {
      const transformed = transformer.push(text);
      if (transformed) {
        chunkQueue.push(transformed);
        chunkResolve?.();
        chunkResolve = null;
      }
    } else {
      chunkQueue.push(text);
      chunkResolve?.();
      chunkResolve = null;
    }
  });

  stderr?.on("data", (data: Buffer) => {
    stderrChunks.push(data.toString());
  });

  const result = new Promise<AgentResult>((resolve) => {
    child.on("error", (err) => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if ("code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({
          sessionId: undefined,
          responseText: `${opts.command} CLI not found`,
          status: "error",
          errorType: "cli_not_found",
          stderrText: "",
        });
      } else {
        resolve({
          sessionId: undefined,
          responseText: err.message,
          status: "error",
          errorType: "execution_error",
          stderrText: "",
        });
      }
    });

    child.on("close", (code, signal) => {
      if (inactivityTimer) clearTimeout(inactivityTimer);

      // Flush transformer at stream end.
      if (transformer) {
        const flushed = transformer.flush();
        if (flushed) chunkQueue.push(flushed);
      }

      streamDone = true;
      chunkResolve?.();
      chunkResolve = null;
      const output = stdoutChunks.join("");
      const stderrText = stderrChunks.join("");
      const parsed = opts.parseResult(output, code, stderrText);

      if (timedOut) {
        resolve({
          ...parsed,
          exitCode: code,
          signal,
          status: "error",
          errorType: "inactivity_timeout",
        });
      } else {
        resolve({ ...parsed, exitCode: code, signal });
      }
    });
  });

  const stream: AgentStream = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (chunkQueue.length > 0) {
          const chunk = chunkQueue.shift();
          if (chunk !== undefined) yield chunk;
        }
        if (streamDone) return;
        await new Promise<void>((r) => {
          chunkResolve = r;
        });
      }
    },
    result,
    child,
  };

  return stream;
}
