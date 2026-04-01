import { describe, expect, test } from "vitest";
import { buildClaudeArgs, parseClaudeResponse } from "./claude-adapter.js";

// ---------------------------------------------------------------------------
// parseClaudeResponse
// ---------------------------------------------------------------------------
describe("parseClaudeResponse", () => {
  test("parses successful response", () => {
    const json = JSON.stringify({
      session_id: "sess-abc-123",
      result: "Hello, world!",
      subtype: "success",
      is_error: false,
    });

    expect(parseClaudeResponse(json)).toEqual({
      sessionId: "sess-abc-123",
      responseText: "Hello, world!",
      status: "success",
      errorType: undefined,
      stderrText: "",
    });
  });

  test("parses error_max_turns response", () => {
    const json = JSON.stringify({
      session_id: "sess-xyz",
      result: "Reached maximum number of turns",
      subtype: "error_max_turns",
      is_error: true,
    });

    expect(parseClaudeResponse(json)).toEqual({
      sessionId: "sess-xyz",
      responseText: "Reached maximum number of turns",
      status: "error",
      errorType: "max_turns",
      stderrText: "",
    });
  });

  test("parses error_during_execution response", () => {
    const json = JSON.stringify({
      session_id: "sess-err",
      result: "Command failed",
      subtype: "error_during_execution",
      is_error: true,
    });

    expect(parseClaudeResponse(json)).toEqual({
      sessionId: "sess-err",
      responseText: "Command failed",
      status: "error",
      errorType: "execution_error",
      stderrText: "",
    });
  });

  test("maps unknown error subtype to 'unknown'", () => {
    const json = JSON.stringify({
      session_id: "sess-unk",
      result: "Something went wrong",
      subtype: "error_something_new",
      is_error: true,
    });

    const result = parseClaudeResponse(json);
    expect(result.status).toBe("error");
    expect(result.errorType).toBe("unknown");
  });

  test("treats empty session_id as undefined", () => {
    const json = JSON.stringify({
      session_id: "",
      result: "response",
      subtype: "success",
      is_error: false,
    });

    expect(parseClaudeResponse(json).sessionId).toBeUndefined();
  });

  test("treats null result as empty string", () => {
    const json = JSON.stringify({
      session_id: "sess-1",
      result: null,
      subtype: "success",
      is_error: false,
    });

    expect(parseClaudeResponse(json).responseText).toBe("");
  });

  test("throws on invalid JSON", () => {
    expect(() => parseClaudeResponse("not json")).toThrow();
  });

  test("preserves multiline result text", () => {
    const json = JSON.stringify({
      session_id: "sess-ml",
      result: "line 1\nline 2\nline 3",
      subtype: "success",
      is_error: false,
    });

    expect(parseClaudeResponse(json).responseText).toBe(
      "line 1\nline 2\nline 3",
    );
  });

  test("preserves unicode in result text", () => {
    const json = JSON.stringify({
      session_id: "sess-u",
      result: "한국어 테스트 🎉",
      subtype: "success",
      is_error: false,
    });

    expect(parseClaudeResponse(json).responseText).toBe("한국어 테스트 🎉");
  });
});

// ---------------------------------------------------------------------------
// buildClaudeArgs
// ---------------------------------------------------------------------------
describe("buildClaudeArgs", () => {
  test("builds basic args with auto permission mode", () => {
    const args = buildClaudeArgs("do something", {
      permissionMode: "auto",
    });

    expect(args).toEqual([
      "-p",
      "do something",
      "--output-format",
      "json",
      "--permission-mode",
      "auto",
    ]);
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
      "json",
      "--model",
      "sonnet",
      "--permission-mode",
      "bypassPermissions",
      "--resume",
      "sess-xyz",
    ]);
  });
});
