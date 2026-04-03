import { describe, expect, test } from "vitest";
import {
  buildCodexInvokeArgs,
  buildCodexResumeArgs,
  CodexStreamTransformer,
  detectCodexError,
  extractCodexResumeResponse,
  extractSessionId,
  parseCodexJsonl,
  parseCodexPlainText,
  validateCodexReasoningEffort,
} from "./codex-adapter.js";

// ---------------------------------------------------------------------------
// parseCodexJsonl — real `codex exec --json` JSONL format
// ---------------------------------------------------------------------------
describe("parseCodexJsonl", () => {
  test("extracts thread_id and agent_message from JSONL events", () => {
    const lines = [
      JSON.stringify({
        type: "thread.started",
        thread_id: "019d46a1-d07f-7bc3-b96d-d50d44001c82",
      }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "reasoning", text: "Thinking..." },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "4" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 5 },
      }),
    ].join("\n");

    expect(parseCodexJsonl(lines)).toEqual({
      sessionId: "019d46a1-d07f-7bc3-b96d-d50d44001c82",
      responseText: "4",
      status: "success",
      errorType: undefined,
      stderrText: "",
    });
  });

  test("uses last agent_message when multiple are present", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "sess-2" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "first" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "final answer" },
      }),
    ].join("\n");

    expect(parseCodexJsonl(lines).responseText).toBe("final answer");
  });

  test("ignores reasoning items for responseText", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "sess-3" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "reasoning", text: "Let me think..." },
      }),
    ].join("\n");

    expect(parseCodexJsonl(lines).responseText).toBe("");
  });

  test("detects turn.failed and returns error", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "sess-fail" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "turn.failed",
        error: { message: "unexpected status 400" },
      }),
    ].join("\n");

    const result = parseCodexJsonl(lines);
    expect(result.status).toBe("error");
    expect(result.responseText).toBe("unexpected status 400");
    expect(result.sessionId).toBe("sess-fail");
  });

  test("detects turn.failed with config parsing message as config_parsing error", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "sess-cfg" }),
      JSON.stringify({
        type: "turn.failed",
        error: {
          message:
            "unknown variant `xhigh`, expected one of `minimal`, `low`, `medium`, `high`",
        },
      }),
    ].join("\n");

    const result = parseCodexJsonl(lines);
    expect(result.status).toBe("error");
    expect(result.errorType).toBe("config_parsing");
    expect(result.sessionId).toBe("sess-cfg");
  });

  test("handles JSONL with only thread.started (no items)", () => {
    const lines = JSON.stringify({
      type: "thread.started",
      thread_id: "sess-4",
    });

    const result = parseCodexJsonl(lines);
    expect(result.sessionId).toBe("sess-4");
    expect(result.responseText).toBe("");
    expect(result.status).toBe("success");
  });

  test("ignores blank lines in input", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "sess-6" }),
      "",
      "  ",
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "ok" },
      }),
    ].join("\n");

    const result = parseCodexJsonl(lines);
    expect(result.sessionId).toBe("sess-6");
    expect(result.responseText).toBe("ok");
  });

  test("skips malformed JSON lines gracefully", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "sess-7" }),
      "not json",
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "ok" },
      }),
    ].join("\n");

    const result = parseCodexJsonl(lines);
    expect(result.sessionId).toBe("sess-7");
    expect(result.responseText).toBe("ok");
  });

  test("handles missing thread.started (sessionId is undefined)", () => {
    const lines = JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "no thread" },
    });

    const result = parseCodexJsonl(lines);
    expect(result.sessionId).toBeUndefined();
    expect(result.responseText).toBe("no thread");
  });

  test("captures first thread_id only", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "first-id" }),
      JSON.stringify({ type: "thread.started", thread_id: "second-id" }),
    ].join("\n");

    expect(parseCodexJsonl(lines).sessionId).toBe("first-id");
  });

  test("ignores unknown event types gracefully", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "sess-unk" }),
      JSON.stringify({ type: "some.future.event", data: 123 }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "hello" },
      }),
    ].join("\n");

    const result = parseCodexJsonl(lines);
    expect(result.responseText).toBe("hello");
    expect(result.status).toBe("success");
  });

  test("detects error events with retry messages", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "sess-retry" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "error",
        message: "stream error: unexpected status 400; retrying 1/5",
      }),
      JSON.stringify({
        type: "turn.failed",
        error: { message: "unexpected status 400" },
      }),
    ].join("\n");

    const result = parseCodexJsonl(lines);
    expect(result.status).toBe("error");
    expect(result.sessionId).toBe("sess-retry");
  });
});

// ---------------------------------------------------------------------------
// extractCodexResumeResponse
// ---------------------------------------------------------------------------
describe("extractCodexResumeResponse", () => {
  const BANNER = [
    "OpenAI Codex v0.46.0 (research preview)",
    "--------",
    "workdir: /some/path",
    "model: gpt-5.4",
    "provider: openai",
    "approval: never",
    "sandbox: read-only",
    "reasoning effort: high",
    "reasoning summaries: auto",
    "session id: 019d46a1-d07f-7bc3-b96d-d50d44001c82",
    "--------",
  ].join("\n");

  test("extracts response from full resume output", () => {
    const text = [
      BANNER,
      "user",
      "What is 2+2?",
      "codex",
      "4",
      "tokens used",
      "229",
    ].join("\n");

    expect(extractCodexResumeResponse(text)).toBe("4");
  });

  test("extracts multiline response", () => {
    const text = [
      BANNER,
      "user",
      "Explain briefly",
      "codex",
      "Line 1",
      "Line 2",
      "Line 3",
      "tokens used",
      "500",
    ].join("\n");

    expect(extractCodexResumeResponse(text)).toBe("Line 1\nLine 2\nLine 3");
  });

  test("returns trimmed text when no codex marker found", () => {
    expect(extractCodexResumeResponse("  raw output  ")).toBe("raw output");
  });

  test("handles missing tokens used footer", () => {
    const text = [BANNER, "user", "prompt", "codex", "answer only"].join("\n");

    expect(extractCodexResumeResponse(text)).toBe("answer only");
  });

  test("handles empty response between markers", () => {
    const text = [
      BANNER,
      "user",
      "prompt",
      "codex",
      "",
      "tokens used",
      "100",
    ].join("\n");

    expect(extractCodexResumeResponse(text)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// parseCodexPlainText
// ---------------------------------------------------------------------------
describe("parseCodexPlainText", () => {
  const BANNER = [
    "OpenAI Codex v0.46.0 (research preview)",
    "--------",
    "workdir: /path",
    "model: gpt-5.4",
    "session id: sess-1",
    "--------",
  ].join("\n");

  function buildResumeOutput(response: string): string {
    return [
      BANNER,
      "user",
      "Question",
      "codex",
      response,
      "tokens used",
      "100",
    ].join("\n");
  }

  test("parses successful plain text response with banner stripping", () => {
    const result = parseCodexPlainText(buildResumeOutput("Answer"), 0, "");
    expect(result.responseText).toBe("Answer");
    expect(result.status).toBe("success");
    expect(result.sessionId).toBe("sess-1");
  });

  test("returns raw text on failure (no banner stripping)", () => {
    const result = parseCodexPlainText("Error: something broke", 1, "");
    expect(result.responseText).toBe("Error: something broke");
    expect(result.status).toBe("error");
  });

  test("detects 'max turns' keyword as max_turns error", () => {
    const result = parseCodexPlainText("Error: max turns reached", 1, "");
    expect(result.status).toBe("error");
    expect(result.errorType).toBe("max_turns");
  });

  test("detects 'turn limit' keyword as max_turns error", () => {
    const result = parseCodexPlainText("Stopped: turn limit exceeded", 1, "");
    expect(result.errorType).toBe("max_turns");
  });

  test("detects 'error during execution' keyword", () => {
    const result = parseCodexPlainText(
      "error during execution of command",
      1,
      "",
    );
    expect(result.status).toBe("error");
    expect(result.errorType).toBe("execution_error");
  });

  test("detects 'execution error' keyword", () => {
    const result = parseCodexPlainText("An execution error occurred", 1, "");
    expect(result.errorType).toBe("execution_error");
  });

  test("detects 'unknown variant' as config_parsing error", () => {
    const result = parseCodexPlainText(
      "",
      1,
      "Error: unknown variant `xhigh`, expected one of `minimal`, `low`, `medium`, `high`\nin `model_reasoning_effort`",
    );
    expect(result.errorType).toBe("config_parsing");
  });

  test("detects 'invalid value' as config_parsing error", () => {
    const result = parseCodexPlainText(
      "",
      1,
      "Error: invalid value for model_reasoning_effort",
    );
    expect(result.errorType).toBe("config_parsing");
  });

  test("keyword detection is case-insensitive", () => {
    expect(parseCodexPlainText("MAX TURNS reached", 1, "").errorType).toBe(
      "max_turns",
    );
    expect(parseCodexPlainText("Error During Execution", 1, "").errorType).toBe(
      "execution_error",
    );
  });

  test("detects error keywords from stderr when stdout is clean", () => {
    const result = parseCodexPlainText(
      "no keywords here",
      1,
      "error during execution",
    );
    expect(result.errorType).toBe("execution_error");
  });

  test("returns unknown error for non-zero exit without keywords", () => {
    const result = parseCodexPlainText("something failed", 1, "");
    expect(result.status).toBe("error");
    expect(result.errorType).toBe("unknown");
  });

  test("handles null exit code as error", () => {
    const result = parseCodexPlainText("killed", null, "");
    expect(result.status).toBe("error");
    expect(result.errorType).toBe("unknown");
  });

  test("handles empty output on success", () => {
    const result = parseCodexPlainText("", 0, "");
    expect(result.responseText).toBe("");
    expect(result.status).toBe("success");
  });

  test("handles empty output on failure", () => {
    const result = parseCodexPlainText("", 1, "");
    expect(result.status).toBe("error");
    expect(result.errorType).toBe("unknown");
  });

  test("extracts sessionId from banner when present", () => {
    expect(
      parseCodexPlainText(buildResumeOutput("Answer"), 0, "").sessionId,
    ).toBe("sess-1");
  });

  test("extracts sessionId from banner even on error exit", () => {
    const text = buildResumeOutput("partial output");
    const result = parseCodexPlainText(text, 1, "");
    expect(result.sessionId).toBe("sess-1");
    expect(result.status).toBe("error");
  });

  test("sessionId is undefined when output has no session id line", () => {
    expect(parseCodexPlainText("response", 0, "").sessionId).toBeUndefined();
    expect(parseCodexPlainText("error", 1, "").sessionId).toBeUndefined();
  });

  test("includes stderrText in result", () => {
    const result = parseCodexPlainText("output", 0, "some warning");
    expect(result.stderrText).toBe("some warning");
  });
});

// ---------------------------------------------------------------------------
// extractSessionId
// ---------------------------------------------------------------------------
describe("extractSessionId", () => {
  test("extracts session ID from banner", () => {
    const text = [
      "OpenAI Codex v0.46.0 (research preview)",
      "--------",
      "session id: 019d46a1-d07f-7bc3-b96d-d50d44001c82",
      "--------",
    ].join("\n");

    expect(extractSessionId(text)).toBe("019d46a1-d07f-7bc3-b96d-d50d44001c82");
  });

  test("returns undefined when no separator lines", () => {
    expect(extractSessionId("session id: fake-id")).toBeUndefined();
  });

  test("returns undefined when no Codex header before separators", () => {
    const text = ["--------", "session id: fake-id", "--------"].join("\n");
    expect(extractSessionId(text)).toBeUndefined();
  });

  test("returns undefined when only one separator line", () => {
    const text = [
      "OpenAI Codex v0.46.0 (research preview)",
      "--------",
      "session id: fake-id",
    ].join("\n");
    expect(extractSessionId(text)).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(extractSessionId("")).toBeUndefined();
  });

  test("handles session id with extra whitespace", () => {
    const text = [
      "OpenAI Codex v0.46.0 (research preview)",
      "--------",
      "session id:   abc-123",
      "--------",
    ].join("\n");
    expect(extractSessionId(text)).toBe("abc-123");
  });

  test("ignores session id in response body outside banner", () => {
    const text = [
      "OpenAI Codex v0.46.0 (research preview)",
      "--------",
      "session id: real-id",
      "--------",
      "user",
      "prompt",
      "codex",
      "session id: fake-id-in-response",
      "tokens used",
      "100",
    ].join("\n");

    expect(extractSessionId(text)).toBe("real-id");
  });

  test("returns undefined when response body contains session id but banner does not", () => {
    const text = [
      "OpenAI Codex v0.46.0 (research preview)",
      "--------",
      "workdir: /path",
      "--------",
      "user",
      "prompt",
      "codex",
      "session id: fake-id-in-response",
      "tokens used",
      "100",
    ].join("\n");

    expect(extractSessionId(text)).toBeUndefined();
  });

  test("ignores fake banner in response body with separators", () => {
    const text = [
      "codex",
      "Here is the session info:",
      "--------",
      "session id: fake-id",
      "--------",
      "tokens used",
      "100",
    ].join("\n");

    expect(extractSessionId(text)).toBeUndefined();
  });

  test("ignores Codex header echoed mid-output with fake banner", () => {
    const text = [
      "codex",
      "The output looks like:",
      "OpenAI Codex v0.46.0 (research preview)",
      "--------",
      "session id: fake-id",
      "--------",
      "tokens used",
      "100",
    ].join("\n");

    expect(extractSessionId(text)).toBeUndefined();
  });

  test("does not match indented session id in banner", () => {
    const text = [
      "OpenAI Codex v0.46.0 (research preview)",
      "--------",
      "  session id: indented",
      "--------",
    ].join("\n");
    expect(extractSessionId(text)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CodexStreamTransformer
// ---------------------------------------------------------------------------
describe("CodexStreamTransformer", () => {
  test("extracts agent_message text from item.completed events", () => {
    const t = new CodexStreamTransformer();

    const chunk = [
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "Hello" },
      }),
      "",
    ].join("\n");

    expect(t.push(chunk)).toBe("Hello\n");
  });

  test("ignores reasoning items", () => {
    const t = new CodexStreamTransformer();

    const chunk = [
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "reasoning", text: "Thinking..." },
      }),
      "",
    ].join("\n");

    expect(t.push(chunk)).toBe("");
  });

  test("ignores non-item events", () => {
    const t = new CodexStreamTransformer();

    const chunk = [
      JSON.stringify({ type: "thread.started", thread_id: "s1" }),
      JSON.stringify({ type: "turn.started" }),
      "",
    ].join("\n");

    expect(t.push(chunk)).toBe("");
  });

  test("buffers incomplete lines across pushes", () => {
    const t = new CodexStreamTransformer();
    const line = JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "Buffered" },
    });

    const half = line.slice(0, 20);
    expect(t.push(half)).toBe("");
    expect(t.push(`${line.slice(20)}\n`)).toBe("Buffered\n");
  });

  test("flush emits buffered content", () => {
    const t = new CodexStreamTransformer();
    const line = JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "end" },
    });

    t.push(line); // no trailing newline
    expect(t.flush()).toBe("end\n");
  });

  test("flush returns empty string when buffer is empty", () => {
    const t = new CodexStreamTransformer();
    expect(t.flush()).toBe("");
  });

  test("flush handles non-JSON content in buffer", () => {
    const t = new CodexStreamTransformer();
    t.push("garbage without newline");
    expect(t.flush()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildCodexInvokeArgs
// ---------------------------------------------------------------------------
describe("buildCodexInvokeArgs", () => {
  test("builds invoke args with default options", () => {
    const args = buildCodexInvokeArgs("do something", {});

    expect(args).toEqual([
      "exec",
      "-s",
      "danger-full-access",
      "--json",
      "do something",
    ]);
  });

  test("includes -m when model is specified", () => {
    const args = buildCodexInvokeArgs("prompt", { model: "gpt-5.4" });

    expect(args).toContain("-m");
    expect(args).toContain("gpt-5.4");
    // prompt comes after model
    expect(args.indexOf("gpt-5.4")).toBeLessThan(args.indexOf("prompt"));
  });

  test("omits -m when model is undefined", () => {
    const args = buildCodexInvokeArgs("prompt", {});
    expect(args).not.toContain("-m");
    expect(args).not.toContain("--model");
  });

  test("does not include -a flag (not supported by CLI)", () => {
    const args = buildCodexInvokeArgs("prompt", {});
    expect(args).not.toContain("-a");
    expect(args).not.toContain("never");
  });

  test("includes -c reasoning effort when specified", () => {
    const args = buildCodexInvokeArgs("prompt", {
      reasoningEffort: "high",
    });

    expect(args).toContain("-c");
    expect(args).toContain("model_reasoning_effort=high");
    // -c value comes before the prompt
    expect(args.indexOf("model_reasoning_effort=high")).toBeLessThan(
      args.indexOf("prompt"),
    );
  });

  test("omits reasoning effort when undefined", () => {
    const args = buildCodexInvokeArgs("prompt", {});
    const reArgs = args.filter((a) => a.includes("model_reasoning_effort"));
    expect(reArgs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildCodexResumeArgs
// ---------------------------------------------------------------------------
describe("buildCodexResumeArgs", () => {
  test("always includes -c sandbox_mode=danger-full-access", () => {
    const args = buildCodexResumeArgs("sess-abc", "continue", {});

    expect(args).toContain("-c");
    expect(args).toContain("sandbox_mode=danger-full-access");
  });

  test("does not include --json (resume outputs plain text)", () => {
    const args = buildCodexResumeArgs("sess-abc", "continue", {});
    expect(args).not.toContain("--json");
  });

  test("includes -c model override when model is specified", () => {
    const args = buildCodexResumeArgs("sess-abc", "continue", {
      model: "gpt-5.3-codex",
    });

    expect(args).toContain("-c");
    expect(args).toContain('model="gpt-5.3-codex"');
  });

  test("omits model override when model is undefined", () => {
    const args = buildCodexResumeArgs("sess-abc", "continue", {});

    const modelArgs = args.filter((a) => a.startsWith('model="'));
    expect(modelArgs).toHaveLength(0);
  });

  test("places session ID and prompt after config flags", () => {
    const args = buildCodexResumeArgs("sess-abc", "continue", {
      model: "gpt-5.4",
    });

    const sessIdx = args.indexOf("sess-abc");
    const promptIdx = args.indexOf("continue");
    expect(sessIdx).toBeGreaterThan(0);
    expect(promptIdx).toBe(sessIdx + 1);
    // Both should come after all -c flags
    const lastCIdx = args.lastIndexOf("-c");
    expect(sessIdx).toBeGreaterThan(lastCIdx + 1);
  });

  test("does not include -s flag (uses -c for sandbox instead)", () => {
    const args = buildCodexResumeArgs("sess-1", "prompt", {});
    expect(args).not.toContain("-s");
  });

  test("does not include -m flag (uses -c for model instead)", () => {
    const args = buildCodexResumeArgs("sess-1", "prompt", {
      model: "gpt-5.4",
    });
    expect(args).not.toContain("-m");
  });

  test("includes -c reasoning effort when specified", () => {
    const args = buildCodexResumeArgs("sess-1", "prompt", {
      reasoningEffort: "medium",
    });

    expect(args).toContain("model_reasoning_effort=medium");
  });

  test("omits reasoning effort when undefined", () => {
    const args = buildCodexResumeArgs("sess-1", "prompt", {});
    const reArgs = args.filter((a) => a.includes("model_reasoning_effort"));
    expect(reArgs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// detectCodexError — error classification
// ---------------------------------------------------------------------------
describe("detectCodexError", () => {
  test("returns max_turns for 'max turns' text", () => {
    expect(detectCodexError("Error: max turns reached")).toBe("max_turns");
  });

  test("returns max_turns for 'turn limit' text", () => {
    expect(detectCodexError("Stopped: turn limit exceeded")).toBe("max_turns");
  });

  test("returns execution_error for 'error during execution'", () => {
    expect(detectCodexError("error during execution of command")).toBe(
      "execution_error",
    );
  });

  test("returns execution_error for 'execution error'", () => {
    expect(detectCodexError("An execution error occurred")).toBe(
      "execution_error",
    );
  });

  test("returns config_parsing for 'unknown variant'", () => {
    expect(
      detectCodexError(
        "Error: unknown variant `xhigh`, expected one of `minimal`, `low`, `medium`, `high`",
      ),
    ).toBe("config_parsing");
  });

  test("returns config_parsing for 'invalid value'", () => {
    expect(
      detectCodexError("Error: invalid value for model_reasoning_effort"),
    ).toBe("config_parsing");
  });

  test("is case-insensitive for config_parsing patterns", () => {
    expect(detectCodexError("Unknown Variant `foo`")).toBe("config_parsing");
    expect(detectCodexError("INVALID VALUE in config")).toBe("config_parsing");
  });

  test("returns unknown for unrecognized errors", () => {
    expect(detectCodexError("something went wrong")).toBe("unknown");
  });

  test("is case-insensitive for all patterns", () => {
    expect(detectCodexError("MAX TURNS reached")).toBe("max_turns");
    expect(detectCodexError("Error During Execution")).toBe("execution_error");
  });
});

// ---------------------------------------------------------------------------
// validateCodexReasoningEffort — runtime validation
// ---------------------------------------------------------------------------
describe("validateCodexReasoningEffort", () => {
  test.each([
    "minimal",
    "low",
    "medium",
    "high",
  ] as const)("accepts valid value: %s", (value) => {
    expect(validateCodexReasoningEffort(value)).toBe(value);
  });

  test("rejects unsupported value with descriptive error", () => {
    expect(() => validateCodexReasoningEffort("xhigh")).toThrow(
      /Unsupported Codex reasoning effort "xhigh"/,
    );
  });

  test("error message lists supported values", () => {
    expect(() => validateCodexReasoningEffort("none")).toThrow(/minimal/);
    expect(() => validateCodexReasoningEffort("none")).toThrow(/high/);
  });

  test("rejects empty string", () => {
    expect(() => validateCodexReasoningEffort("")).toThrow(/Unsupported/);
  });
});
