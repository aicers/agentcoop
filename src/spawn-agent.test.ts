import { type ChildProcess, spawn } from "node:child_process";
import EventEmitter from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

const { spawnAgent } = await import("./spawn-agent.js");
const { createClaudeAdapter } = await import("./claude-adapter.js");
const { createCodexAdapter } = await import("./codex-adapter.js");

const mockSpawn = vi.mocked(spawn);

function createMockChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = null;
  child.stdio = [null, child.stdout, child.stderr, null, null];
  child.pid = 12345;
  child.connected = false;
  child.signalCode = null;
  child.exitCode = null;
  child.killed = false;
  child.kill = vi.fn();
  child.send = vi.fn();
  child.disconnect = vi.fn();
  child.unref = vi.fn();
  child.ref = vi.fn();
  child.serialize = "json";
  child[Symbol.dispose] = vi.fn();
  return child;
}

function emitStdout(child: ChildProcess, data: string): void {
  (child.stdout as PassThrough).write(data);
}

function emitStderr(child: ChildProcess, data: string): void {
  (child.stderr as PassThrough).write(data);
}

function endStdout(child: ChildProcess): void {
  (child.stdout as PassThrough).end();
}

afterEach(() => {
  mockSpawn.mockReset();
});

// ---------------------------------------------------------------------------
// spawnAgent basics
// ---------------------------------------------------------------------------
describe("spawnAgent", () => {
  test("passes command, args, and cwd to spawn", () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    spawnAgent({
      command: "test-cli",
      args: ["--flag", "value"],
      cwd: "/some/dir",
      parseResult: () => ({
        sessionId: undefined,
        responseText: "",
        status: "success",
        errorType: undefined,
        stderrText: "",
      }),
    });

    expect(mockSpawn).toHaveBeenCalledWith("test-cli", ["--flag", "value"], {
      cwd: "/some/dir",
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  test("resolves result with parsed stdout on exit 0", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const stream = spawnAgent({
      command: "echo",
      args: [],
      parseResult: (output, code) => ({
        sessionId: "s1",
        responseText: output,
        status: code === 0 ? "success" : "error",
        errorType: undefined,
        stderrText: "",
      }),
    });

    emitStdout(child, "hello ");
    emitStdout(child, "world");
    child.emit("close", 0);

    const result = await stream.result;
    expect(result).toEqual({
      sessionId: "s1",
      responseText: "hello world",
      status: "success",
      errorType: undefined,
      stderrText: "",
    });
  });

  test("resolves result with non-zero exit code", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const stream = spawnAgent({
      command: "fail",
      args: [],
      parseResult: (_output, code) => ({
        sessionId: undefined,
        responseText: "failed",
        status: code === 0 ? "success" : "error",
        errorType: "unknown",
        stderrText: "",
      }),
    });

    child.emit("close", 1);

    const result = await stream.result;
    expect(result.status).toBe("error");
  });

  test("resolves cli_not_found on ENOENT error", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const stream = spawnAgent({
      command: "nonexistent",
      args: [],
      parseResult: () => ({
        sessionId: undefined,
        responseText: "",
        status: "success",
        errorType: undefined,
        stderrText: "",
      }),
    });

    const err = new Error("spawn nonexistent ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    child.emit("error", err);

    const result = await stream.result;
    expect(result).toEqual({
      sessionId: undefined,
      responseText: "nonexistent CLI not found",
      status: "error",
      errorType: "cli_not_found",
      stderrText: "",
    });
  });

  test("rejects on non-ENOENT spawn error", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const stream = spawnAgent({
      command: "cmd",
      args: [],
      parseResult: () => ({
        sessionId: undefined,
        responseText: "",
        status: "success",
        errorType: undefined,
        stderrText: "",
      }),
    });

    const err = new Error("permission denied") as NodeJS.ErrnoException;
    err.code = "EACCES";
    child.emit("error", err);

    await expect(stream.result).rejects.toThrow("permission denied");
  });

  test("passes only stdout to parseResult output param", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    let capturedOutput = "";
    const stream = spawnAgent({
      command: "cmd",
      args: [],
      parseResult: (output, _code, stderrText) => {
        capturedOutput = output;
        return {
          sessionId: undefined,
          responseText: output,
          status: "success",
          errorType: undefined,
          stderrText,
        };
      },
    });

    emitStdout(child, "stdout data");
    emitStderr(child, "stderr noise");
    child.emit("close", 0);

    await stream.result;
    expect(capturedOutput).toBe("stdout data");
  });

  test("passes stderr to parseResult stderrText param", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    let capturedStderr = "";
    const stream = spawnAgent({
      command: "cmd",
      args: [],
      parseResult: (output, _code, stderrText) => {
        capturedStderr = stderrText;
        return {
          sessionId: undefined,
          responseText: output,
          status: "success",
          errorType: undefined,
          stderrText,
        };
      },
    });

    emitStdout(child, "out");
    emitStderr(child, "err msg");
    child.emit("close", 0);

    await stream.result;
    expect(capturedStderr).toBe("err msg");
  });

  test("handles empty output (no stdout data before close)", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const stream = spawnAgent({
      command: "cmd",
      args: [],
      parseResult: (output, code) => ({
        sessionId: undefined,
        responseText: output,
        status: code === 0 ? "success" : "error",
        errorType: undefined,
        stderrText: "",
      }),
    });

    child.emit("close", 0);

    const result = await stream.result;
    expect(result.responseText).toBe("");
    expect(result.status).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------
describe("streaming", () => {
  test("async iterator yields all stdout data", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const stream = spawnAgent({
      command: "cmd",
      args: [],
      parseResult: () => ({
        sessionId: undefined,
        responseText: "",
        status: "success",
        errorType: undefined,
        stderrText: "",
      }),
    });

    const chunks: string[] = [];
    const iteratorDone = (async () => {
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
    })();

    const pt = child.stdout as PassThrough;
    pt.write("chunk1");
    pt.write("chunk2");
    pt.write("chunk3");
    pt.end();

    child.emit("close", 0);
    await iteratorDone;

    // PassThrough may coalesce synchronous writes into one chunk,
    // so verify concatenated content rather than chunk boundaries.
    expect(chunks.join("")).toBe("chunk1chunk2chunk3");
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  test("result resolves even if iterator is not consumed", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const stream = spawnAgent({
      command: "cmd",
      args: [],
      parseResult: (output) => ({
        sessionId: undefined,
        responseText: output,
        status: "success",
        errorType: undefined,
        stderrText: "",
      }),
    });

    emitStdout(child, "data");
    endStdout(child);
    child.emit("close", 0);

    const result = await stream.result;
    expect(result.responseText).toBe("data");
  });

  test("iterator and result both receive data simultaneously", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const stream = spawnAgent({
      command: "cmd",
      args: [],
      parseResult: (output) => ({
        sessionId: undefined,
        responseText: output,
        status: "success",
        errorType: undefined,
        stderrText: "",
      }),
    });

    // Consume iterator concurrently with result.
    const chunks: string[] = [];
    const iteratorDone = (async () => {
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
    })();

    emitStdout(child, "part1");
    emitStdout(child, "part2");
    endStdout(child);
    child.emit("close", 0);

    const result = await stream.result;
    await iteratorDone;

    // Both paths should see all data.
    expect(chunks.join("")).toBe("part1part2");
    expect(result.responseText).toBe("part1part2");
  });

  test("exposes child process for cancellation", () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const stream = spawnAgent({
      command: "cmd",
      args: [],
      parseResult: () => ({
        sessionId: undefined,
        responseText: "",
        status: "success",
        errorType: undefined,
        stderrText: "",
      }),
    });

    expect(stream.child).toBe(child);
    expect(stream.child.kill).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// E2E: Claude adapter full flow
// ---------------------------------------------------------------------------
describe("Claude adapter invoke/resume (E2E with mock spawn)", () => {
  test("invoke sends correct args and returns parsed result", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const adapter = createClaudeAdapter({
      model: "opus",
      permissionMode: "auto",
    });

    const stream = adapter.invoke("write tests");

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["-p", "write tests", "--model", "opus"]),
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );

    const responseJson = JSON.stringify({
      session_id: "sess-new",
      result: "Done!",
      subtype: "success",
      is_error: false,
    });
    emitStdout(child, responseJson);
    child.emit("close", 0);

    const result = await stream.result;
    expect(result.sessionId).toBe("sess-new");
    expect(result.responseText).toBe("Done!");
    expect(result.status).toBe("success");
  });

  test("resume includes --resume flag with session ID", () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const adapter = createClaudeAdapter({ permissionMode: "bypass" });
    adapter.resume("sess-prev", "continue working");

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining([
        "--resume",
        "sess-prev",
        "--permission-mode",
        "bypassPermissions",
      ]),
      expect.anything(),
    );
  });

  test("invoke with cwd passes working directory", () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const adapter = createClaudeAdapter();
    adapter.invoke("prompt", { cwd: "/worktree/path" });

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      expect.any(Array),
      expect.objectContaining({ cwd: "/worktree/path" }),
    );
  });

  test("handles non-JSON output gracefully", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const adapter = createClaudeAdapter();
    const stream = adapter.invoke("prompt");

    emitStdout(child, "not valid json at all");
    child.emit("close", 0);

    const result = await stream.result;
    expect(result.status).toBe("error");
    expect(result.errorType).toBe("unknown");
    expect(result.responseText).toBe("not valid json at all");
  });

  test("handles empty output with non-zero exit", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const adapter = createClaudeAdapter();
    const stream = adapter.invoke("prompt");

    child.emit("close", 1);

    const result = await stream.result;
    expect(result.status).toBe("error");
    expect(result.responseText).toContain("claude exited with code 1");
  });

  test("captures stderr in result on error", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const adapter = createClaudeAdapter();
    const stream = adapter.invoke("prompt");

    emitStderr(child, "Error: invalid session");
    child.emit("close", 1);

    const result = await stream.result;
    expect(result.stderrText).toBe("Error: invalid session");
  });
});

// ---------------------------------------------------------------------------
// E2E: Codex adapter full flow
// ---------------------------------------------------------------------------
describe("Codex adapter invoke/resume (E2E with mock spawn)", () => {
  test("invoke sends correct args and returns parsed JSONL result", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const adapter = createCodexAdapter({ model: "gpt-5.4" });
    const stream = adapter.invoke("fix the bug");

    expect(mockSpawn).toHaveBeenCalledWith(
      "codex",
      expect.arrayContaining([
        "exec",
        "-s",
        "danger-full-access",
        "--json",
        "-m",
        "gpt-5.4",
        "-c",
        "model_reasoning_effort=high",
      ]),
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );

    const jsonl = [
      JSON.stringify({
        type: "thread.started",
        thread_id: "codex-sess-1",
      }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "Fixed!" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    ].join("\n");

    emitStdout(child, jsonl);
    child.emit("close", 0);

    const result = await stream.result;
    expect(result.sessionId).toBe("codex-sess-1");
    expect(result.responseText).toBe("Fixed!");
    expect(result.status).toBe("success");
  });

  test("invoke does not include -a flag", () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const adapter = createCodexAdapter();
    adapter.invoke("prompt");

    const spawnArgs = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(spawnArgs).not.toContain("-a");
    expect(spawnArgs).not.toContain("never");
  });

  test("defaults reasoning effort to high when not specified", () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const adapter = createCodexAdapter();
    adapter.invoke("prompt");

    const spawnArgs = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(spawnArgs).toContain("model_reasoning_effort=high");
  });

  test("invoke passes reasoning effort via -c", () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const adapter = createCodexAdapter({ reasoningEffort: "high" });
    adapter.invoke("prompt");

    const spawnArgs = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(spawnArgs).toContain("-c");
    expect(spawnArgs).toContain("model_reasoning_effort=high");
  });

  test("resume passes reasoning effort via -c", () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const adapter = createCodexAdapter({ reasoningEffort: "medium" });
    adapter.resume("sess-1", "continue");

    const spawnArgs = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(spawnArgs).toContain("model_reasoning_effort=medium");
  });

  test("resume uses plain text parsing with -c config overrides", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const adapter = createCodexAdapter({ model: "gpt-5.3-codex" });
    const stream = adapter.resume("sess-prev", "keep going");

    const spawnArgs = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(spawnArgs).toContain("resume");
    expect(spawnArgs).toContain("sess-prev");
    expect(spawnArgs).toContain("-c");
    expect(spawnArgs).toContain("sandbox_mode=danger-full-access");
    expect(spawnArgs).toContain('model="gpt-5.3-codex"');
    expect(spawnArgs).toContain("model_reasoning_effort=high");
    expect(spawnArgs).not.toContain("--json");
    expect(spawnArgs).not.toContain("-m");

    const resumeOutput = [
      "OpenAI Codex v0.46.0 (research preview)",
      "--------",
      "workdir: /tmp",
      "model: gpt-5.4",
      "session id: sess-prev",
      "--------",
      "user",
      "keep going",
      "codex",
      "Continued work done.",
      "tokens used",
      "150",
    ].join("\n");

    emitStdout(child, resumeOutput);
    child.emit("close", 0);

    const result = await stream.result;
    expect(result.responseText).toBe("Continued work done.");
    expect(result.status).toBe("success");
    expect(result.sessionId).toBe("sess-prev");
  });

  test("resume falls back to input sessionId when output has no session id line", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const adapter = createCodexAdapter();
    const stream = adapter.resume("sess-input", "keep going");

    // Output without a "session id:" banner line (e.g. older CLI version).
    emitStdout(child, "codex\nDone.\ntokens used\n50");
    child.emit("close", 0);

    const result = await stream.result;
    expect(result.sessionId).toBe("sess-input");
    expect(result.status).toBe("success");
  });

  test("resume preserves sessionId on error exit", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const adapter = createCodexAdapter();
    const stream = adapter.resume("sess-err", "continue");

    emitStdout(child, "Error: max turns reached");
    child.emit("close", 1);

    const result = await stream.result;
    expect(result.status).toBe("error");
    expect(result.errorType).toBe("max_turns");
    expect(result.sessionId).toBe("sess-err");
  });

  test("resume prefers parsed sessionId over input when banner has one", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const adapter = createCodexAdapter();
    // Pass "old-sess" as input, but the CLI output contains "new-sess".
    const stream = adapter.resume("old-sess", "keep going");

    const resumeOutput = [
      "OpenAI Codex v0.46.0 (research preview)",
      "--------",
      "session id: new-sess",
      "--------",
      "user",
      "keep going",
      "codex",
      "Done.",
      "tokens used",
      "50",
    ].join("\n");

    emitStdout(child, resumeOutput);
    child.emit("close", 0);

    const result = await stream.result;
    expect(result.sessionId).toBe("new-sess");
  });

  test("invoke with cwd passes working directory", () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const adapter = createCodexAdapter();
    adapter.invoke("prompt", { cwd: "/worktree/path" });

    expect(mockSpawn).toHaveBeenCalledWith(
      "codex",
      expect.any(Array),
      expect.objectContaining({ cwd: "/worktree/path" }),
    );
  });

  test("invoke with non-zero exit marks result as error", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const adapter = createCodexAdapter();
    const stream = adapter.invoke("prompt");

    const jsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "sess-fail" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "turn.failed",
        error: { message: "API error" },
      }),
    ].join("\n");

    emitStdout(child, jsonl);
    child.emit("close", 1);

    const result = await stream.result;
    expect(result.status).toBe("error");
    expect(result.sessionId).toBe("sess-fail");
  });

  test("invoke handles invalid JSONL output gracefully on success", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const adapter = createCodexAdapter();
    const stream = adapter.invoke("prompt");

    emitStdout(child, "not json");
    child.emit("close", 0);

    const result = await stream.result;
    expect(result.status).toBe("success");
    expect(result.responseText).toBe("not json");
  });

  test("invoke handles invalid JSONL output with non-zero exit", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const adapter = createCodexAdapter();
    const stream = adapter.invoke("prompt");

    emitStdout(child, "garbage output");
    child.emit("close", 1);

    const result = await stream.result;
    expect(result.status).toBe("error");
    expect(result.errorType).toBe("unknown");
    expect(result.responseText).toBe("garbage output");
  });

  test("captures stderr in result for diagnostics", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const adapter = createCodexAdapter();
    const stream = adapter.resume("sess-1", "continue");

    emitStderr(child, "unexpected argument '--model'");
    child.emit("close", 2);

    const result = await stream.result;
    expect(result.status).toBe("error");
    expect(result.stderrText).toBe("unexpected argument '--model'");
  });
});
