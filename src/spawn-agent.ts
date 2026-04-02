import { spawn } from "node:child_process";
import type { AgentResult, AgentStream } from "./agent.js";

export interface SpawnAgentOptions {
  command: string;
  args: string[];
  cwd?: string;
  parseResult: (
    output: string,
    exitCode: number | null,
    stderrText: string,
  ) => AgentResult;
}

export function spawnAgent(opts: SpawnAgentOptions): AgentStream {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const { stdout, stderr } = child;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  // Async queue: data listener is the single consumer of the stdout
  // stream.  It pushes to stdoutChunks (for the result promise) and to
  // chunkQueue (for the async iterator).  This avoids the conflict
  // between consuming a readable via both `data` events and
  // `for await`.
  const chunkQueue: string[] = [];
  let chunkResolve: (() => void) | null = null;
  let streamDone = false;

  stdout?.on("data", (data: Buffer) => {
    const text = data.toString();
    stdoutChunks.push(text);
    chunkQueue.push(text);
    chunkResolve?.();
    chunkResolve = null;
  });

  stderr?.on("data", (data: Buffer) => {
    stderrChunks.push(data.toString());
  });

  const result = new Promise<AgentResult>((resolve, reject) => {
    child.on("error", (err) => {
      if ("code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({
          sessionId: undefined,
          responseText: `${opts.command} CLI not found`,
          status: "error",
          errorType: "cli_not_found",
          stderrText: "",
        });
      } else {
        reject(err);
      }
    });

    child.on("close", (code) => {
      streamDone = true;
      chunkResolve?.();
      chunkResolve = null;
      const output = stdoutChunks.join("");
      const stderrText = stderrChunks.join("");
      resolve(opts.parseResult(output, code, stderrText));
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
