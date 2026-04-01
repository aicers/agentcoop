import type {
  AgentAdapter,
  AgentErrorType,
  AgentResult,
  InvokeOptions,
} from "./agent.js";
import { spawnAgent } from "./spawn-agent.js";

/**
 * Shape of the final JSON object emitted by `claude -p --output-format json`.
 */
export interface ClaudeJsonResponse {
  session_id: string;
  result: string;
  subtype: string;
  is_error: boolean;
}

export function parseClaudeResponse(json: string): AgentResult {
  const parsed: ClaudeJsonResponse = JSON.parse(json);
  return {
    sessionId: parsed.session_id || undefined,
    responseText: parsed.result ?? "",
    status: parsed.is_error ? "error" : "success",
    errorType: parsed.is_error ? claudeErrorType(parsed.subtype) : undefined,
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

export type ClaudePermissionMode = "auto" | "bypass";

export interface ClaudeAdapterOptions {
  model?: string;
  permissionMode?: ClaudePermissionMode;
}

export function buildClaudeArgs(
  prompt: string,
  opts: { model?: string; permissionMode: ClaudePermissionMode },
  sessionId?: string,
): string[] {
  const args = ["-p", prompt, "--output-format", "json"];
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
    const result = parseClaudeResponse(output);
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

export function createClaudeAdapter(
  opts: ClaudeAdapterOptions = {},
): AgentAdapter {
  const model = opts.model;
  const permissionMode = opts.permissionMode ?? "auto";

  return {
    invoke(prompt, options?: InvokeOptions) {
      return spawnAgent({
        command: "claude",
        args: buildClaudeArgs(prompt, { model, permissionMode }),
        cwd: options?.cwd,
        parseResult: parseClaudeOutput,
      });
    },
    resume(sessionId, prompt, options?: InvokeOptions) {
      return spawnAgent({
        command: "claude",
        args: buildClaudeArgs(prompt, { model, permissionMode }, sessionId),
        cwd: options?.cwd,
        parseResult: parseClaudeOutput,
      });
    },
  };
}
