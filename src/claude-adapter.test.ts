import { describe, expect, test } from "vitest";
import {
  buildClaudeArgs,
  ClaudeStreamTransformer,
  parseClaudeStreamJson,
} from "./claude-adapter.js";

// ---------------------------------------------------------------------------
// parseClaudeStreamJson
// ---------------------------------------------------------------------------
describe("parseClaudeStreamJson", () => {
  function streamJsonl(events: object[]): string {
    return events.map((e) => JSON.stringify(e)).join("\n");
  }

  test("parses successful stream-json output", () => {
    const jsonl = streamJsonl([
      { type: "system", subtype: "init", session_id: "sess-abc-123" },
      {
        type: "assistant",
        session_id: "sess-abc-123",
        message: { content: [{ type: "text", text: "Hello, world!" }] },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "sess-abc-123",
        is_error: false,
        result: "Hello, world!",
      },
    ]);

    expect(parseClaudeStreamJson(jsonl)).toEqual({
      sessionId: "sess-abc-123",
      responseText: "Hello, world!",
      status: "success",
      errorType: undefined,
      stderrText: "",
    });
  });

  test("parses error_max_turns response", () => {
    const jsonl = streamJsonl([
      { type: "system", subtype: "init", session_id: "sess-xyz" },
      {
        type: "result",
        subtype: "error_max_turns",
        session_id: "sess-xyz",
        is_error: true,
        result: "Reached maximum number of turns",
      },
    ]);

    expect(parseClaudeStreamJson(jsonl)).toEqual({
      sessionId: "sess-xyz",
      responseText: "Reached maximum number of turns",
      status: "error",
      errorType: "max_turns",
      stderrText: "",
    });
  });

  test("parses error_during_execution response", () => {
    const jsonl = streamJsonl([
      { type: "system", subtype: "init", session_id: "sess-err" },
      {
        type: "result",
        subtype: "error_during_execution",
        session_id: "sess-err",
        is_error: true,
        result: "Command failed",
      },
    ]);

    expect(parseClaudeStreamJson(jsonl)).toEqual({
      sessionId: "sess-err",
      responseText: "Command failed",
      status: "error",
      errorType: "execution_error",
      stderrText: "",
    });
  });

  test("maps unknown error subtype to 'unknown'", () => {
    const jsonl = streamJsonl([
      {
        type: "result",
        subtype: "error_something_new",
        session_id: "sess-unk",
        is_error: true,
        result: "Something went wrong",
      },
    ]);

    const result = parseClaudeStreamJson(jsonl);
    expect(result.status).toBe("error");
    expect(result.errorType).toBe("unknown");
  });

  test("treats empty session_id as undefined", () => {
    const jsonl = streamJsonl([
      {
        type: "result",
        subtype: "success",
        session_id: "",
        is_error: false,
        result: "response",
      },
    ]);

    expect(parseClaudeStreamJson(jsonl).sessionId).toBeUndefined();
  });

  test("handles result with error field instead of result field", () => {
    const jsonl = streamJsonl([
      {
        type: "result",
        subtype: "error",
        session_id: "sess-1",
        is_error: true,
        error: "something failed",
      },
    ]);

    const result = parseClaudeStreamJson(jsonl);
    expect(result.responseText).toBe("something failed");
    expect(result.status).toBe("error");
  });

  test("extracts session_id from system init event", () => {
    const jsonl = streamJsonl([
      { type: "system", subtype: "init", session_id: "from-init" },
      {
        type: "result",
        subtype: "success",
        session_id: "from-result",
        is_error: false,
        result: "ok",
      },
    ]);

    // result event overrides the init session_id
    expect(parseClaudeStreamJson(jsonl).sessionId).toBe("from-result");
  });

  test("uses init session_id when result has none", () => {
    const jsonl = streamJsonl([
      { type: "system", subtype: "init", session_id: "from-init" },
      {
        type: "result",
        subtype: "success",
        session_id: "",
        is_error: false,
        result: "ok",
      },
    ]);

    expect(parseClaudeStreamJson(jsonl).sessionId).toBe("from-init");
  });

  test("skips malformed JSON lines gracefully", () => {
    const jsonl = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      }),
      "not valid json",
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "sess-1",
        is_error: false,
        result: "ok",
      }),
    ].join("\n");

    const result = parseClaudeStreamJson(jsonl);
    expect(result.sessionId).toBe("sess-1");
    expect(result.responseText).toBe("ok");
    expect(result.status).toBe("success");
  });

  test("handles empty input", () => {
    const result = parseClaudeStreamJson("");
    expect(result.sessionId).toBeUndefined();
    expect(result.responseText).toBe("");
    expect(result.status).toBe("success");
  });

  test("returns empty responseText when no result event exists", () => {
    const jsonl = streamJsonl([
      { type: "system", subtype: "init", session_id: "sess-no-result" },
      {
        type: "assistant",
        session_id: "sess-no-result",
        message: { content: [{ type: "text", text: "partial" }] },
      },
    ]);

    const result = parseClaudeStreamJson(jsonl);
    expect(result.sessionId).toBe("sess-no-result");
    expect(result.responseText).toBe("");
    expect(result.status).toBe("success");
  });

  test("handles result event with neither result nor error field", () => {
    const jsonl = streamJsonl([
      {
        type: "result",
        subtype: "success",
        session_id: "sess-empty",
        is_error: false,
      },
    ]);

    const result = parseClaudeStreamJson(jsonl);
    expect(result.responseText).toBe("");
    expect(result.status).toBe("success");
  });

  test("ignores assistant and user events for result extraction", () => {
    const jsonl = streamJsonl([
      { type: "system", subtype: "init", session_id: "s1" },
      {
        type: "assistant",
        session_id: "s1",
        message: { content: [{ type: "text", text: "turn 1 text" }] },
      },
      {
        type: "user",
        session_id: "s1",
        message: { content: [{ type: "tool_result" }] },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "s1",
        is_error: false,
        result: "final answer",
      },
    ]);

    const result = parseClaudeStreamJson(jsonl);
    expect(result.responseText).toBe("final answer");
  });

  test("preserves multiline result text", () => {
    const jsonl = streamJsonl([
      {
        type: "result",
        subtype: "success",
        session_id: "sess-ml",
        is_error: false,
        result: "line 1\nline 2\nline 3",
      },
    ]);

    expect(parseClaudeStreamJson(jsonl).responseText).toBe(
      "line 1\nline 2\nline 3",
    );
  });

  test("preserves unicode in result text", () => {
    const jsonl = streamJsonl([
      {
        type: "result",
        subtype: "success",
        session_id: "sess-u",
        is_error: false,
        result: "한국어 테스트 🎉",
      },
    ]);

    expect(parseClaudeStreamJson(jsonl).responseText).toBe("한국어 테스트 🎉");
  });
});

// ---------------------------------------------------------------------------
// ClaudeStreamTransformer
// ---------------------------------------------------------------------------
describe("ClaudeStreamTransformer", () => {
  test("extracts text from assistant event content blocks", () => {
    const t = new ClaudeStreamTransformer();

    const chunk = [
      JSON.stringify({
        type: "assistant",
        session_id: "s1",
        message: { content: [{ type: "text", text: "Hello world" }] },
      }),
      "",
    ].join("\n");

    expect(t.push(chunk)).toBe("Hello world\n");
  });

  test("concatenates multiple text blocks in one assistant event", () => {
    const t = new ClaudeStreamTransformer();

    const chunk = [
      JSON.stringify({
        type: "assistant",
        session_id: "s1",
        message: {
          content: [
            { type: "text", text: "Part 1. " },
            { type: "tool_use", id: "tool_1", name: "Read" },
            { type: "text", text: "Part 2." },
          ],
        },
      }),
      "",
    ].join("\n");

    expect(t.push(chunk)).toBe("Part 1. Part 2.\n");
  });

  test("ignores non-assistant events", () => {
    const t = new ClaudeStreamTransformer();

    const chunk = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "s1",
        is_error: false,
        result: "ok",
      }),
      JSON.stringify({ type: "rate_limit_event", rate_limit_info: {} }),
      "",
    ].join("\n");

    expect(t.push(chunk)).toBe("");
  });

  test("ignores tool_use content blocks (no text field)", () => {
    const t = new ClaudeStreamTransformer();

    const chunk = [
      JSON.stringify({
        type: "assistant",
        session_id: "s1",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Bash" }],
        },
      }),
      "",
    ].join("\n");

    expect(t.push(chunk)).toBe("");
  });

  test("buffers incomplete lines across pushes", () => {
    const t = new ClaudeStreamTransformer();
    const line = JSON.stringify({
      type: "assistant",
      session_id: "s1",
      message: { content: [{ type: "text", text: "Hi" }] },
    });

    // Send first half
    const half = line.slice(0, 20);
    expect(t.push(half)).toBe("");

    // Send second half with newline
    expect(t.push(`${line.slice(20)}\n`)).toBe("Hi\n");
  });

  test("flush emits buffered content", () => {
    const t = new ClaudeStreamTransformer();
    const line = JSON.stringify({
      type: "assistant",
      session_id: "s1",
      message: { content: [{ type: "text", text: "end" }] },
    });

    t.push(line); // no trailing newline, stays in buffer
    expect(t.flush()).toBe("end\n");
  });

  test("flush returns empty string when buffer is empty", () => {
    const t = new ClaudeStreamTransformer();
    expect(t.flush()).toBe("");
  });

  test("flushed final event followed by new streamed event stays separated", () => {
    const t = new ClaudeStreamTransformer();
    const event1 = JSON.stringify({
      type: "assistant",
      session_id: "s1",
      message: { content: [{ type: "text", text: "First run done." }] },
    });
    const event2 = JSON.stringify({
      type: "assistant",
      session_id: "s1",
      message: {
        content: [{ type: "text", text: "Second run starting." }],
      },
    });

    // First event sits in buffer (no trailing newline), then flushed
    t.push(event1);
    const flushed = t.flush();
    expect(flushed).toBe("First run done.\n");

    // Second event arrives as a new stream
    const pushed = t.push(`${event2}\n`);
    expect(pushed).toBe("Second run starting.\n");

    // Concatenating the two should have a clear separator
    expect(flushed + pushed).toBe("First run done.\nSecond run starting.\n");
  });

  test("handles JSON split mid-character across multiple pushes", () => {
    const t = new ClaudeStreamTransformer();
    const line = JSON.stringify({
      type: "assistant",
      session_id: "s1",
      message: { content: [{ type: "text", text: "split" }] },
    });

    const parts = [line.slice(0, 5), line.slice(5, 30), `${line.slice(30)}\n`];
    expect(t.push(parts[0])).toBe("");
    expect(t.push(parts[1])).toBe("");
    expect(t.push(parts[2])).toBe("split\n");
  });

  test("handles multiple assistant events in a single push", () => {
    const t = new ClaudeStreamTransformer();
    const events = [
      JSON.stringify({
        type: "assistant",
        session_id: "s1",
        message: { content: [{ type: "text", text: "Turn 1" }] },
      }),
      JSON.stringify({
        type: "user",
        session_id: "s1",
        message: { content: [] },
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "s1",
        message: { content: [{ type: "text", text: "Turn 2" }] },
      }),
      "",
    ].join("\n");

    expect(t.push(events)).toBe("Turn 1\nTurn 2\n");
  });

  test("handles assistant event with empty content array", () => {
    const t = new ClaudeStreamTransformer();

    const chunk = [
      JSON.stringify({
        type: "assistant",
        session_id: "s1",
        message: { content: [] },
      }),
      "",
    ].join("\n");

    expect(t.push(chunk)).toBe("");
  });

  test("flush handles non-JSON content in buffer", () => {
    const t = new ClaudeStreamTransformer();
    t.push("garbage without newline");
    expect(t.flush()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildClaudeArgs
// ---------------------------------------------------------------------------
describe("buildClaudeArgs", () => {
  test("builds basic args with auto permission mode and --verbose", () => {
    const args = buildClaudeArgs("do something", {
      permissionMode: "auto",
    });

    expect(args).toEqual([
      "-p",
      "do something",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "auto",
    ]);
  });

  test("always includes --verbose (required by stream-json)", () => {
    const args = buildClaudeArgs("prompt", { permissionMode: "auto" });
    expect(args).toContain("--verbose");
  });

  test("builds args with bypass permission mode", () => {
    const args = buildClaudeArgs("prompt", {
      permissionMode: "bypass",
    });

    expect(args).toContain("--permission-mode");
    expect(args).toContain("bypassPermissions");
  });

  test("includes --model when model is specified", () => {
    const args = buildClaudeArgs("prompt", {
      model: "opus",
      permissionMode: "auto",
    });

    expect(args).toContain("--model");
    expect(args).toContain("opus");
  });

  test("omits --model when model is undefined", () => {
    const args = buildClaudeArgs("prompt", {
      permissionMode: "auto",
    });

    expect(args).not.toContain("--model");
  });

  test("includes --effort when effortLevel is set", () => {
    const args = buildClaudeArgs("prompt", {
      permissionMode: "auto",
      effortLevel: "high",
    });

    expect(args).toContain("--effort");
    expect(args).toContain("high");
  });

  test("omits --effort when effortLevel is undefined", () => {
    const args = buildClaudeArgs("prompt", {
      permissionMode: "auto",
    });

    expect(args).not.toContain("--effort");
  });

  test("appends [1m] to model when contextWindow is 1m", () => {
    const args = buildClaudeArgs("prompt", {
      model: "opus",
      permissionMode: "auto",
      contextWindow: "1m",
    });

    expect(args).toContain("opus[1m]");
  });

  test("does not modify model when contextWindow is 200k", () => {
    const args = buildClaudeArgs("prompt", {
      model: "opus",
      permissionMode: "auto",
      contextWindow: "200k",
    });

    expect(args).toContain("opus");
    expect(args).not.toContain("opus[1m]");
  });

  test("includes --resume when sessionId is given", () => {
    const args = buildClaudeArgs(
      "continue",
      { permissionMode: "auto" },
      "sess-123",
    );

    expect(args).toContain("--resume");
    expect(args).toContain("sess-123");
  });

  test("omits --resume when sessionId is undefined", () => {
    const args = buildClaudeArgs("prompt", {
      permissionMode: "auto",
    });

    expect(args).not.toContain("--resume");
  });

  test("combines all options together", () => {
    const args = buildClaudeArgs(
      "full prompt",
      { model: "sonnet", permissionMode: "bypass" },
      "sess-xyz",
    );

    expect(args).toEqual([
      "-p",
      "full prompt",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "sonnet",
      "--permission-mode",
      "bypassPermissions",
      "--resume",
      "sess-xyz",
    ]);
  });
});
