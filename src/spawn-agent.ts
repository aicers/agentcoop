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

  const result = new Promise<AgentResult>((resolve, reject) => {
    stdout?.on("data", (data: Buffer) => {
      stdoutChunks.push(data.toString());
    });

    stderr?.on("data", (data: Buffer) => {
      stderrChunks.push(data.toString());
    });

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
      const output = stdoutChunks.join("");
      const stderrText = stderrChunks.join("");
      resolve(opts.parseResult(output, code, stderrText));
    });
  });

  const stream: AgentStream = {
    async *[Symbol.asyncIterator]() {
      if (!stdout) return;
      for await (const chunk of stdout) {
        const text =
          typeof chunk === "string" ? chunk : (chunk as Buffer).toString();
        yield text;
      }
    },
    result,
    child,
  };

  return stream;
}
