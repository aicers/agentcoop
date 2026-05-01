import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentAdapter, AgentResult, AgentStream } from "./agent.js";
import { PipelineEventEmitter } from "./pipeline-events.js";
import {
  buildDocConsistencyInstructions,
  invokeOrResume,
  mapAgentError,
  mapFixOrDoneResponse,
  mapParsedStepToResult,
  mapResponseToResult,
  sendFollowUp,
  type VerdictContext,
} from "./stage-util.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- helpers ---------------------------------------------------------------

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    sessionId: "sess-1",
    responseText: "ok",
    status: "success",
    errorType: undefined,
    stderrText: "",
    ...overrides,
  };
}

function makeStream(result: AgentResult): AgentStream {
  return {
    [Symbol.asyncIterator]() {
      return { next: async () => ({ done: true, value: "" }) };
    },
    result: Promise.resolve(result),
    child: {} as AgentStream["child"],
  };
}

/**
 * Create a stream that yields the given chunks before resolving.
 */
function makeStreamWithChunks(
  result: AgentResult,
  chunks: string[],
): AgentStream {
  let idx = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          if (idx < chunks.length) {
            return { done: false, value: chunks[idx++] };
          }
          return { done: true, value: "" };
        },
      };
    },
    result: Promise.resolve(result),
    child: {} as AgentStream["child"],
  };
}

// ---- mapAgentError ---------------------------------------------------------

describe("mapAgentError", () => {
  const base: AgentResult = {
    sessionId: undefined,
    responseText: "",
    status: "error",
    errorType: undefined,
    stderrText: "",
  };

  test("maps max_turns to descriptive message", () => {
    const result = mapAgentError({ ...base, errorType: "max_turns" });
    expect(result.outcome).toBe("error");
    expect(result.message).toBe("Agent hit the maximum turn limit.");
  });

  test("includes context string when provided", () => {
    const result = mapAgentError(
      { ...base, errorType: "max_turns" },
      "during self-check",
    );
    expect(result.message).toBe(
      "Agent hit the maximum turn limit during self-check.",
    );
  });

  test("includes errorType alongside stderrText", () => {
    const result = mapAgentError({
      ...base,
      errorType: "execution_error",
      stderrText: "segfault",
    });
    expect(result.message).toBe("Agent error: execution_error (segfault)");
  });

  test("includes errorType, stderrText, and exit code", () => {
    const result = mapAgentError({
      ...base,
      errorType: "execution_error",
      stderrText: "segfault",
      exitCode: 1,
    });
    expect(result.message).toBe(
      "Agent error: execution_error (segfault, exit code 1)",
    );
  });

  test("includes errorType alongside responseText when no process details", () => {
    const result = mapAgentError({
      ...base,
      errorType: "execution_error",
      stderrText: "",
      exitCode: null,
      responseText: "claude exited with code 1",
    });
    expect(result.message).toBe(
      "Agent error: execution_error (claude exited with code 1)",
    );
  });

  test("includes errorType alongside exit code", () => {
    const result = mapAgentError({
      ...base,
      errorType: "unknown",
      stderrText: "",
      exitCode: 137,
      responseText: "",
    });
    expect(result.message).toBe("Agent error: unknown (exit code 137)");
  });

  test("falls back to errorType when all details are empty", () => {
    const result = mapAgentError({
      ...base,
      errorType: "execution_error",
      stderrText: "",
      responseText: "",
    });
    expect(result.message).toBe("Agent error: execution_error");
  });

  test("falls back to 'unknown' when everything is empty", () => {
    const result = mapAgentError(base);
    expect(result.message).toBe("Agent error: unknown");
  });

  test("includes context with non-max_turns error", () => {
    const result = mapAgentError({ ...base, stderrText: "oops" }, "during fix");
    expect(result.message).toBe("Agent error during fix: oops");
  });

  test("includes errorType alongside signal", () => {
    const result = mapAgentError({
      ...base,
      errorType: "unknown",
      stderrText: "",
      exitCode: null,
      signal: "SIGKILL",
      responseText: "",
    });
    expect(result.message).toBe("Agent error: unknown (signal SIGKILL)");
  });

  test("includes errorType, stderr, and signal", () => {
    const result = mapAgentError({
      ...base,
      errorType: "unknown",
      stderrText: "out of memory",
      exitCode: null,
      signal: "SIGKILL",
    });
    expect(result.message).toBe(
      "Agent error: unknown (out of memory, signal SIGKILL)",
    );
  });

  test("logs full diagnostics to stderr on error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mapAgentError({
      ...base,
      errorType: "execution_error",
      stderrText: "segfault",
      exitCode: 139,
      signal: "SIGSEGV",
    });
    expect(spy).toHaveBeenCalledOnce();
    const logged = spy.mock.calls[0][0] as string;
    expect(logged).toContain("errorType=execution_error");
    expect(logged).toContain("exitCode=139");
    expect(logged).toContain("signal=SIGSEGV");
    expect(logged).toContain("stderr=segfault");
  });

  test("maps config_parsing to actionable message with stderr detail", () => {
    const stderr =
      "Error: unknown variant `xhigh`, expected one of `minimal`, `low`, `medium`, `high`";
    const result = mapAgentError({
      ...base,
      errorType: "config_parsing",
      stderrText: stderr,
    });
    expect(result.outcome).toBe("error");
    expect(result.message).toContain("~/.codex/config.toml");
    expect(result.message).toContain(stderr);
  });

  test("config_parsing includes context when provided", () => {
    const result = mapAgentError(
      {
        ...base,
        errorType: "config_parsing",
        stderrText: "invalid value",
      },
      " during review",
    );
    expect(result.message).toContain("during review");
    expect(result.message).toContain("invalid value");
  });

  test("config_parsing falls back to responseText when stderrText is empty", () => {
    const result = mapAgentError({
      ...base,
      errorType: "config_parsing",
      stderrText: "",
      responseText: "unknown variant `xhigh`",
    });
    expect(result.message).toContain("unknown variant `xhigh`");
    expect(result.message).toContain("~/.codex/config.toml");
  });

  test("config_parsing falls back to 'unknown' when both stderr and response are empty", () => {
    const result = mapAgentError({
      ...base,
      errorType: "config_parsing",
      stderrText: "",
      responseText: "",
    });
    expect(result.message).toContain("unknown");
    expect(result.message).toContain("~/.codex/config.toml");
  });
});

// ---- mapParsedStepToResult -------------------------------------------------

describe("mapParsedStepToResult", () => {
  test("maps completed status", () => {
    const result = mapParsedStepToResult(
      { status: "completed", keyword: "COMPLETED" },
      "done",
    );
    expect(result).toEqual({ outcome: "completed", message: "done" });
  });

  test("maps fixed status to completed by default", () => {
    const result = mapParsedStepToResult(
      { status: "fixed", keyword: "FIXED" },
      "fixed it",
    );
    expect(result).toEqual({ outcome: "completed", message: "fixed it" });
  });

  test("maps blocked status", () => {
    const result = mapParsedStepToResult(
      { status: "blocked", keyword: "BLOCKED" },
      "stuck",
    );
    expect(result).toEqual({ outcome: "blocked", message: "stuck" });
  });

  test("maps not_approved status", () => {
    const result = mapParsedStepToResult(
      { status: "not_approved", keyword: "NOT_APPROVED" },
      "nope",
    );
    expect(result).toEqual({ outcome: "not_approved", message: "nope" });
  });

  test("maps approved status to completed", () => {
    const result = mapParsedStepToResult(
      { status: "approved", keyword: "APPROVED" },
      "lgtm",
    );
    expect(result).toEqual({ outcome: "completed", message: "lgtm" });
  });

  test("maps ambiguous status to needs_clarification", () => {
    const result = mapParsedStepToResult(
      { status: "ambiguous", keyword: undefined },
      "huh",
    );
    expect(result).toEqual({ outcome: "needs_clarification", message: "huh" });
  });

  test("applies overrides", () => {
    const result = mapParsedStepToResult(
      { status: "fixed", keyword: "FIXED" },
      "patched",
      { fixed: "not_approved" },
    );
    expect(result).toEqual({ outcome: "not_approved", message: "patched" });
  });

  test("overrides do not affect non-overridden statuses", () => {
    const result = mapParsedStepToResult(
      { status: "completed", keyword: "COMPLETED" },
      "ok",
      { fixed: "not_approved" },
    );
    expect(result).toEqual({ outcome: "completed", message: "ok" });
  });

  test("rejects out-of-scope keyword when validKeywords is provided", () => {
    const result = mapParsedStepToResult(
      { status: "completed", keyword: "COMPLETED" },
      "All done. COMPLETED",
      undefined,
      ["FIXED", "DONE"],
    );
    expect(result.outcome).toBe("needs_clarification");
    expect(result.validVerdicts).toEqual(["FIXED", "DONE"]);
  });

  test("accepts in-scope keyword when validKeywords is provided", () => {
    const result = mapParsedStepToResult(
      { status: "fixed", keyword: "FIXED" },
      "Patched. FIXED",
      undefined,
      ["FIXED", "DONE"],
    );
    expect(result).toEqual({ outcome: "completed", message: "Patched. FIXED" });
  });

  test("attaches validVerdicts on ambiguous when validKeywords provided", () => {
    const result = mapParsedStepToResult(
      { status: "ambiguous", keyword: undefined },
      "no keyword here",
      undefined,
      ["FIXED", "DONE"],
    );
    expect(result.outcome).toBe("needs_clarification");
    expect(result.validVerdicts).toEqual(["FIXED", "DONE"]);
  });

  test("does not attach validVerdicts when validKeywords is not provided", () => {
    const result = mapParsedStepToResult(
      { status: "ambiguous", keyword: undefined },
      "no keyword here",
    );
    expect(result.outcome).toBe("needs_clarification");
    expect(result.validVerdicts).toBeUndefined();
  });

  test("keyword comparison is case-insensitive", () => {
    const result = mapParsedStepToResult(
      { status: "fixed", keyword: "FIXED" },
      "FIXED",
      undefined,
      ["fixed", "done"],
    );
    // "FIXED" matches "fixed" (case-insensitive), so it should be accepted.
    expect(result.outcome).toBe("completed");
  });
});

// ---- mapResponseToResult ---------------------------------------------------

describe("mapResponseToResult", () => {
  test("parses COMPLETED from text", () => {
    const result = mapResponseToResult("All done.\n\nCOMPLETED");
    expect(result.outcome).toBe("completed");
  });

  test("parses BLOCKED from text", () => {
    const result = mapResponseToResult("Cannot proceed.\n\nBLOCKED");
    expect(result.outcome).toBe("blocked");
  });

  test("returns needs_clarification for ambiguous text", () => {
    const result = mapResponseToResult("I did some work.");
    expect(result.outcome).toBe("needs_clarification");
  });

  test("applies overrides when parsing", () => {
    const result = mapResponseToResult("Patched.\n\nFIXED", {
      fixed: "not_approved",
    });
    expect(result.outcome).toBe("not_approved");
  });

  test("preserves full response text in message", () => {
    const text = "Long response.\n\nCOMPLETED";
    const result = mapResponseToResult(text);
    expect(result.message).toBe(text);
  });

  test("rejects out-of-scope keyword with validKeywords", () => {
    const result = mapResponseToResult("All done.\n\nCOMPLETED", undefined, [
      "FIXED",
      "DONE",
    ]);
    expect(result.outcome).toBe("needs_clarification");
    expect(result.validVerdicts).toEqual(["FIXED", "DONE"]);
  });

  test("accepts in-scope keyword with validKeywords (exact response)", () => {
    const result = mapResponseToResult("FIXED", undefined, ["FIXED", "DONE"]);
    expect(result.outcome).toBe("completed");
  });

  test("rejects in-scope keyword with extra commentary when validKeywords is provided", () => {
    const result = mapResponseToResult("Patched.\n\nFIXED", undefined, [
      "FIXED",
      "DONE",
    ]);
    expect(result.outcome).toBe("needs_clarification");
  });

  test("passes validKeywords through with overrides (exact response)", () => {
    const result = mapResponseToResult("FIXED", { fixed: "not_approved" }, [
      "FIXED",
      "DONE",
    ]);
    expect(result.outcome).toBe("not_approved");
  });

  // -- strict parser regression tests ----------------------------------------

  test("rejects two in-scope keywords in one response", () => {
    const result = mapResponseToResult("COMPLETED then BLOCKED", undefined, [
      "COMPLETED",
      "BLOCKED",
    ]);
    expect(result.outcome).toBe("needs_clarification");
  });

  test("rejects extra commentary ending in valid keyword", () => {
    const result = mapResponseToResult(
      "Round 1 items are now APPROVED",
      undefined,
      ["APPROVED", "NOT_APPROVED"],
    );
    expect(result.outcome).toBe("needs_clarification");
  });

  test("accepts keyword with trailing punctuation", () => {
    const result = mapResponseToResult("COMPLETED.", undefined, [
      "COMPLETED",
      "BLOCKED",
    ]);
    expect(result.outcome).toBe("completed");
  });

  test("emits pipeline:verdict when verdictCtx is provided", () => {
    const events = new PipelineEventEmitter();
    const handler = vi.fn();
    events.on("pipeline:verdict", handler);
    const ctx: VerdictContext = { events, agent: "a" };

    mapResponseToResult("COMPLETED", undefined, ["COMPLETED", "BLOCKED"], ctx);

    expect(handler).toHaveBeenCalledWith({
      agent: "a",
      keyword: "COMPLETED",
      raw: "COMPLETED",
    });
  });

  test("does not emit pipeline:verdict without verdictCtx", () => {
    const events = new PipelineEventEmitter();
    const handler = vi.fn();
    events.on("pipeline:verdict", handler);

    mapResponseToResult("COMPLETED", undefined, ["COMPLETED", "BLOCKED"]);

    expect(handler).not.toHaveBeenCalled();
  });

  test("does not emit pipeline:verdict when keyword is not parsed", () => {
    const events = new PipelineEventEmitter();
    const handler = vi.fn();
    events.on("pipeline:verdict", handler);
    const ctx: VerdictContext = { events, agent: "a" };

    mapResponseToResult("I did some work.", undefined, ["COMPLETED"], ctx);

    expect(handler).not.toHaveBeenCalled();
  });
});

// ---- mapFixOrDoneResponse ---------------------------------------------------

describe("mapFixOrDoneResponse", () => {
  test("maps DONE to completed (pipeline advances)", () => {
    // DONE and FIXED both parse to status "fixed" in the step parser,
    // but the keyword-level check ensures only FIXED loops.
    const result = mapFixOrDoneResponse("Everything looks good.\n\nDONE");
    expect(result.outcome).toBe("completed");
  });

  test("maps FIXED to not_approved (pipeline loops)", () => {
    const result = mapFixOrDoneResponse("Patched the issue.\n\nFIXED");
    expect(result.outcome).toBe("not_approved");
  });

  test("distinguishes DONE from FIXED despite both having 'fixed' status", () => {
    // Both DONE and FIXED map to StepStatus "fixed" in the parser.
    // mapFixOrDoneResponse must check the keyword to differentiate.
    const done = mapFixOrDoneResponse("All verified.\n\nDONE");
    const fixed = mapFixOrDoneResponse("Patched one item.\n\nFIXED");
    expect(done.outcome).toBe("completed");
    expect(fixed.outcome).toBe("not_approved");
  });

  test("maps COMPLETED to completed", () => {
    const result = mapFixOrDoneResponse("All set.\n\nCOMPLETED");
    expect(result.outcome).toBe("completed");
  });

  test("maps BLOCKED to blocked", () => {
    const result = mapFixOrDoneResponse("Cannot fix.\n\nBLOCKED");
    expect(result.outcome).toBe("blocked");
  });

  test("maps NOT_APPROVED to not_approved", () => {
    const result = mapFixOrDoneResponse("Not right.\n\nNOT_APPROVED");
    expect(result.outcome).toBe("not_approved");
  });

  test("maps ambiguous to needs_clarification", () => {
    const result = mapFixOrDoneResponse("I looked at things.");
    expect(result.outcome).toBe("needs_clarification");
  });

  test("preserves response text in message", () => {
    const text = "Fixed several items.\n\nFIXED";
    const result = mapFixOrDoneResponse(text);
    expect(result.message).toBe(text);
  });

  test("rejects out-of-scope keyword with validKeywords", () => {
    const result = mapFixOrDoneResponse("Review passed.\n\nAPPROVED", [
      "FIXED",
      "DONE",
    ]);
    expect(result.outcome).toBe("needs_clarification");
    expect(result.validVerdicts).toEqual(["FIXED", "DONE"]);
  });

  test("accepts DONE with validKeywords containing DONE (exact response)", () => {
    const result = mapFixOrDoneResponse("DONE", ["FIXED", "DONE"]);
    expect(result.outcome).toBe("completed");
  });

  test("accepts FIXED with validKeywords containing FIXED (exact response)", () => {
    const result = mapFixOrDoneResponse("FIXED", ["FIXED", "DONE"]);
    expect(result.outcome).toBe("not_approved");
  });

  test("rejects in-scope keyword with extra commentary when validKeywords is provided", () => {
    const result = mapFixOrDoneResponse("All good.\n\nDONE", ["FIXED", "DONE"]);
    expect(result.outcome).toBe("needs_clarification");
  });

  test("attaches validVerdicts on ambiguous with validKeywords", () => {
    const result = mapFixOrDoneResponse("I looked at things.", [
      "FIXED",
      "DONE",
    ]);
    expect(result.outcome).toBe("needs_clarification");
    expect(result.validVerdicts).toEqual(["FIXED", "DONE"]);
  });

  test("backward compatible without validKeywords", () => {
    const result = mapFixOrDoneResponse("Patched.\n\nFIXED");
    expect(result.outcome).toBe("not_approved");
    expect(result.validVerdicts).toBeUndefined();
  });

  // -- strict parser regression tests ----------------------------------------

  test("rejects FIXED and DONE in same response with validKeywords", () => {
    const result = mapFixOrDoneResponse("FIXED and DONE", ["FIXED", "DONE"]);
    expect(result.outcome).toBe("needs_clarification");
  });

  test("rejects DONE with extra commentary when validKeywords is provided", () => {
    const result = mapFixOrDoneResponse("ISSUE_NO_CHANGES\n\nDONE", [
      "FIXED",
      "DONE",
    ]);
    expect(result.outcome).toBe("needs_clarification");
  });

  test("emits pipeline:verdict when verdictCtx is provided", () => {
    const events = new PipelineEventEmitter();
    const handler = vi.fn();
    events.on("pipeline:verdict", handler);
    const ctx: VerdictContext = { events, agent: "b" };

    mapFixOrDoneResponse("FIXED", ["FIXED", "DONE"], ctx);

    expect(handler).toHaveBeenCalledWith({
      agent: "b",
      keyword: "FIXED",
      raw: "FIXED",
    });
  });

  test("does not emit pipeline:verdict without verdictCtx", () => {
    const events = new PipelineEventEmitter();
    const handler = vi.fn();
    events.on("pipeline:verdict", handler);

    mapFixOrDoneResponse("FIXED", ["FIXED", "DONE"]);

    expect(handler).not.toHaveBeenCalled();
  });

  test("does not emit pipeline:verdict when keyword is not parsed", () => {
    const events = new PipelineEventEmitter();
    const handler = vi.fn();
    events.on("pipeline:verdict", handler);
    const ctx: VerdictContext = { events, agent: "a" };

    mapFixOrDoneResponse("I looked at things.", ["FIXED", "DONE"], ctx);

    expect(handler).not.toHaveBeenCalled();
  });
});

// ---- sendFollowUp ----------------------------------------------------------

describe("sendFollowUp", () => {
  test("resumes session when sessionId is provided", async () => {
    const expected = makeResult({ responseText: "resumed" });
    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi.fn().mockReturnValue(makeStream(expected)),
    };

    const result = await sendFollowUp(agent, "sess-42", "prompt", "/cwd");

    expect(agent.resume).toHaveBeenCalledWith("sess-42", "prompt", {
      cwd: "/cwd",
    });
    expect(agent.invoke).not.toHaveBeenCalled();
    expect(result.responseText).toBe("resumed");
  });

  test("throws when sessionId is undefined", async () => {
    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi.fn(),
    };

    await expect(
      sendFollowUp(agent, undefined, "prompt", "/cwd"),
    ).rejects.toThrow("no session ID");
    expect(agent.invoke).not.toHaveBeenCalled();
    expect(agent.resume).not.toHaveBeenCalled();
  });
});

// ---- invokeOrResume --------------------------------------------------------

describe("invokeOrResume", () => {
  test("invokes fresh when no saved session ID", async () => {
    const result = makeResult({ sessionId: "new-sess" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(result)),
      resume: vi.fn(),
    };

    const out = await invokeOrResume(agent, undefined, "prompt", "/cwd");
    expect(out).toBe(result);
    expect(agent.invoke).toHaveBeenCalledWith("prompt", { cwd: "/cwd" });
    expect(agent.resume).not.toHaveBeenCalled();
  });

  test("resumes when saved session ID is available and succeeds", async () => {
    const result = makeResult({ sessionId: "resumed-sess" });
    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi.fn().mockReturnValue(makeStream(result)),
    };

    const out = await invokeOrResume(agent, "saved-sess", "prompt", "/cwd");
    expect(out).toBe(result);
    expect(agent.resume).toHaveBeenCalledWith("saved-sess", "prompt", {
      cwd: "/cwd",
    });
    expect(agent.invoke).not.toHaveBeenCalled();
  });

  test("falls back to invoke when resume returns error", async () => {
    const errorResult = makeResult({
      status: "error",
      errorType: "unknown",
      stderrText: "session expired",
    });
    const freshResult = makeResult({ sessionId: "fresh-sess" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(freshResult)),
      resume: vi.fn().mockReturnValue(makeStream(errorResult)),
    };

    const out = await invokeOrResume(agent, "old-sess", "prompt", "/cwd");
    expect(out).toBe(freshResult);
    expect(agent.resume).toHaveBeenCalledOnce();
    expect(agent.invoke).toHaveBeenCalledOnce();
  });

  test("falls back to invoke on max_turns (recoverable)", async () => {
    const maxTurnsResult = makeResult({
      status: "error",
      errorType: "max_turns",
    });
    const freshResult = makeResult({ sessionId: "fresh" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(freshResult)),
      resume: vi.fn().mockReturnValue(makeStream(maxTurnsResult)),
    };

    const out = await invokeOrResume(agent, "saved-sess", "prompt", "/cwd");
    expect(out).toBe(freshResult);
    expect(agent.resume).toHaveBeenCalledOnce();
    expect(agent.invoke).toHaveBeenCalledOnce();
  });

  test("returns error immediately on cli_not_found (non-recoverable)", async () => {
    const cliNotFound = makeResult({
      status: "error",
      errorType: "cli_not_found",
      stderrText: "claude: not found",
    });
    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi.fn().mockReturnValue(makeStream(cliNotFound)),
    };

    const out = await invokeOrResume(agent, "saved-sess", "prompt", "/cwd");
    expect(out).toBe(cliNotFound);
    expect(agent.invoke).not.toHaveBeenCalled();
  });

  test("returns error immediately on execution_error (non-recoverable)", async () => {
    const execError = makeResult({
      status: "error",
      errorType: "execution_error",
      stderrText: "segfault",
    });
    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi.fn().mockReturnValue(makeStream(execError)),
    };

    const out = await invokeOrResume(agent, "saved-sess", "prompt", "/cwd");
    expect(out).toBe(execError);
    expect(agent.invoke).not.toHaveBeenCalled();
  });

  test("uses fallbackPrompt for fresh invoke when resume falls through", async () => {
    // Saved session triggers a resume; a soft error like "session
    // expired / unknown" makes the helper fall back to a fresh
    // invoke.  When `fallbackPrompt` is supplied, the fresh invoke
    // must use it (the compact resume-form prompt is only safe on a
    // live session — fresh agents need full context).
    const errorResult = makeResult({
      status: "error",
      errorType: "unknown",
      stderrText: "session expired",
    });
    const freshResult = makeResult({ sessionId: "fresh-sess" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(freshResult)),
      resume: vi.fn().mockReturnValue(makeStream(errorResult)),
    };
    const promptSink = vi.fn();

    const out = await invokeOrResume(
      agent,
      "old-sess",
      "compact resume prompt",
      "/cwd",
      undefined,
      {
        fallbackPrompt: "full fresh prompt",
        promptSink,
        promptKind: "work",
      },
    );

    expect(out).toBe(freshResult);
    // Resume tried with the compact prompt, fresh invoke used the
    // full fallback prompt.
    expect(agent.resume).toHaveBeenCalledWith(
      "old-sess",
      "compact resume prompt",
      { cwd: "/cwd", onUsage: undefined },
    );
    expect(agent.invoke).toHaveBeenCalledWith("full fresh prompt", {
      cwd: "/cwd",
      onUsage: undefined,
    });
    // Prompt sink received a follow-up event reflecting the fresh
    // prompt actually sent.
    expect(promptSink).toHaveBeenCalledWith(
      "full fresh prompt",
      "work",
      undefined,
    );
  });

  test("does not emit fallback prompt-sink event when fallback is unused", async () => {
    // When the resume succeeds, the fallback path is never taken so
    // the helper must not emit a duplicate prompt-sink event.
    const result = makeResult({ sessionId: "resumed-sess" });
    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi.fn().mockReturnValue(makeStream(result)),
    };
    const promptSink = vi.fn();

    await invokeOrResume(
      agent,
      "saved-sess",
      "compact resume prompt",
      "/cwd",
      undefined,
      {
        fallbackPrompt: "full fresh prompt",
        promptSink,
        promptKind: "work",
      },
    );

    expect(agent.invoke).not.toHaveBeenCalled();
    expect(promptSink).not.toHaveBeenCalled();
  });

  test("legacy positional usageSink still works", async () => {
    const result = makeResult({ sessionId: "fresh-sess" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(result)),
      resume: vi.fn(),
    };
    const usageSink = vi.fn();

    await invokeOrResume(
      agent,
      undefined,
      "p",
      "/cwd",
      undefined,
      3,
      usageSink,
    );

    expect(agent.invoke).toHaveBeenCalledWith("p", {
      cwd: "/cwd",
      onUsage: usageSink,
    });
  });

  test("returns error immediately on config_parsing (non-recoverable)", async () => {
    const configError = makeResult({
      status: "error",
      errorType: "config_parsing",
      stderrText:
        "Error: unknown variant `xhigh`, expected one of `minimal`, `low`, `medium`, `high`",
    });
    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi.fn().mockReturnValue(makeStream(configError)),
    };

    const out = await invokeOrResume(agent, "saved-sess", "prompt", "/cwd");
    expect(out).toBe(configError);
    expect(agent.invoke).not.toHaveBeenCalled();
  });
});

// ---- StreamSink integration --------------------------------------------------

describe("invokeOrResume with StreamSink", () => {
  test("sink receives chunks from invoke when no saved session", async () => {
    const result = makeResult({ responseText: "chunk1chunk2" });
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(makeStreamWithChunks(result, ["chunk1", "chunk2"])),
      resume: vi.fn(),
    };

    const collected: string[] = [];
    const sink = (chunk: string) => collected.push(chunk);

    const out = await invokeOrResume(agent, undefined, "prompt", "/cwd", sink);

    expect(out).toBe(result);
    expect(collected).toEqual(["chunk1", "chunk2"]);
  });

  test("sink receives chunks from resume", async () => {
    const result = makeResult({ responseText: "data" });
    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi
        .fn()
        .mockReturnValue(makeStreamWithChunks(result, ["a", "b", "c"])),
    };

    const collected: string[] = [];
    const out = await invokeOrResume(
      agent,
      "saved-id",
      "prompt",
      "/cwd",
      (chunk) => collected.push(chunk),
    );

    expect(out).toBe(result);
    expect(collected).toEqual(["a", "b", "c"]);
  });

  test("result is correct even without a sink", async () => {
    const result = makeResult({ responseText: "hello" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStreamWithChunks(result, ["hello"])),
      resume: vi.fn(),
    };

    const out = await invokeOrResume(agent, undefined, "prompt", "/cwd");
    expect(out.responseText).toBe("hello");
  });
});

describe("sendFollowUp with StreamSink", () => {
  test("sink receives chunks during follow-up", async () => {
    const result = makeResult({ responseText: "follow-up done" });
    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi
        .fn()
        .mockReturnValue(makeStreamWithChunks(result, ["f1", "f2"])),
    };

    const collected: string[] = [];
    const out = await sendFollowUp(agent, "sess-1", "prompt", "/cwd", (chunk) =>
      collected.push(chunk),
    );

    expect(out.responseText).toBe("follow-up done");
    expect(collected).toEqual(["f1", "f2"]);
  });

  test("works without sink (backward compatible)", async () => {
    const result = makeResult({ responseText: "ok" });
    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi.fn().mockReturnValue(makeStream(result)),
    };

    const out = await sendFollowUp(agent, "sess-1", "prompt", "/cwd");
    expect(out.responseText).toBe("ok");
  });
});

// ---- drainToSink edge cases -------------------------------------------------

describe("drainToSink", () => {
  test("all chunks are delivered before caller resumes (regression for #205)", async () => {
    const result = makeResult({ responseText: "ok" });
    // Iterator that yields on separate event-loop turns, simulating
    // real I/O where chunks arrive after stream.result resolves.
    const chunks = ["x", "y", "z"];
    let idx = 0;
    const stream: AgentStream = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            await new Promise<void>((r) => setTimeout(r, 0));
            if (idx < chunks.length) {
              return { done: false, value: chunks[idx++] };
            }
            return { done: true, value: "" };
          },
        };
      },
      result: Promise.resolve(result),
      child: {} as AgentStream["child"],
    };

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(stream),
      resume: vi.fn(),
    };

    const collected: string[] = [];
    await invokeOrResume(agent, undefined, "prompt", "/cwd", (chunk) =>
      collected.push(chunk),
    );

    // Before the fix, drainToSink was fire-and-forget so the function
    // returned as soon as stream.result resolved — while the iterator
    // still had pending setTimeout turns.  This assertion would fail
    // because collected would be incomplete.
    expect(collected).toEqual(["x", "y", "z"]);
  });

  test("result resolves independently even when sink throws", async () => {
    const result = makeResult({ responseText: "completed" });
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(makeStreamWithChunks(result, ["c1", "c2"])),
      resume: vi.fn(),
    };

    const sink = vi.fn().mockImplementation(() => {
      throw new Error("sink exploded");
    });

    // drainToSink swallows sink errors, so .result should still resolve.
    const out = await invokeOrResume(agent, undefined, "prompt", "/cwd", sink);

    expect(out).toBe(result);
    // sink was called at least once before the error stopped the drain.
    expect(sink).toHaveBeenCalled();
  });

  test("sink receives all chunks in order", async () => {
    const result = makeResult({ responseText: "done" });
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStreamWithChunks(result, ["first", "second", "third"]),
        ),
      resume: vi.fn(),
    };

    const collected: string[] = [];
    await invokeOrResume(agent, undefined, "prompt", "/cwd", (chunk) =>
      collected.push(chunk),
    );

    expect(collected).toEqual(["first", "second", "third"]);
  });
});

// ---- inactivity auto-resume -------------------------------------------------

describe("invokeOrResume inactivity auto-resume", () => {
  test("auto-resumes on inactivity timeout up to max attempts", async () => {
    const timeoutResult = makeResult({
      sessionId: "sess-timeout",
      status: "error",
      errorType: "inactivity_timeout",
    });
    const successResult = makeResult({
      sessionId: "sess-timeout",
      responseText: "finally done",
    });

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(timeoutResult)),
      resume: vi
        .fn()
        .mockReturnValueOnce(makeStream(timeoutResult))
        .mockReturnValueOnce(makeStream(successResult)),
    };

    const out = await invokeOrResume(
      agent,
      undefined,
      "prompt",
      "/cwd",
      undefined,
      3,
    );

    // invoke was called once, then 2 resumes (first timeout, second success).
    expect(agent.invoke).toHaveBeenCalledOnce();
    expect(agent.resume).toHaveBeenCalledTimes(2);
    expect(out.responseText).toBe("finally done");
    expect(out.status).toBe("success");
  });

  test("returns timeout error when all auto-resume attempts exhausted", async () => {
    const timeoutResult = makeResult({
      sessionId: "sess-stuck",
      status: "error",
      errorType: "inactivity_timeout",
    });

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(timeoutResult)),
      resume: vi.fn().mockReturnValue(makeStream(timeoutResult)),
    };

    const out = await invokeOrResume(
      agent,
      undefined,
      "prompt",
      "/cwd",
      undefined,
      2,
    );

    // invoke once + 2 resume retries = 2 resume calls.
    expect(agent.invoke).toHaveBeenCalledOnce();
    expect(agent.resume).toHaveBeenCalledTimes(2);
    expect(out.errorType).toBe("inactivity_timeout");
  });

  test("does not auto-resume when sessionId is missing", async () => {
    const timeoutResult = makeResult({
      sessionId: undefined,
      status: "error",
      errorType: "inactivity_timeout",
    });

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(timeoutResult)),
      resume: vi.fn(),
    };

    const out = await invokeOrResume(
      agent,
      undefined,
      "prompt",
      "/cwd",
      undefined,
      3,
    );

    expect(agent.resume).not.toHaveBeenCalled();
    expect(out.errorType).toBe("inactivity_timeout");
  });
});

describe("sendFollowUp inactivity auto-resume", () => {
  test("auto-resumes on inactivity timeout", async () => {
    const timeoutResult = makeResult({
      sessionId: "sess-1",
      status: "error",
      errorType: "inactivity_timeout",
    });
    const successResult = makeResult({
      sessionId: "sess-1",
      responseText: "resumed ok",
    });

    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi
        .fn()
        .mockReturnValueOnce(makeStream(timeoutResult))
        .mockReturnValueOnce(makeStream(successResult)),
    };

    const out = await sendFollowUp(
      agent,
      "sess-1",
      "prompt",
      "/cwd",
      undefined,
      3,
    );

    // First resume (original call) + 1 retry resume.
    expect(agent.resume).toHaveBeenCalledTimes(2);
    expect(out.responseText).toBe("resumed ok");
  });

  test("returns timeout error after exhausting retries", async () => {
    const timeoutResult = makeResult({
      sessionId: "sess-1",
      status: "error",
      errorType: "inactivity_timeout",
    });

    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi.fn().mockReturnValue(makeStream(timeoutResult)),
    };

    const out = await sendFollowUp(
      agent,
      "sess-1",
      "prompt",
      "/cwd",
      undefined,
      1,
    );

    // Original call + 1 retry = 2 total.
    expect(agent.resume).toHaveBeenCalledTimes(2);
    expect(out.errorType).toBe("inactivity_timeout");
  });
});

describe("invokeOrResume: timeout does not fall through to fresh invoke", () => {
  test("returns timeout error without invoking fresh when resume times out", async () => {
    const timeoutResult = makeResult({
      sessionId: "sess-saved",
      status: "error",
      errorType: "inactivity_timeout",
    });

    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi.fn().mockReturnValue(makeStream(timeoutResult)),
    };

    // With maxAutoResumes=0 to isolate the fallthrough behavior.
    const out = await invokeOrResume(
      agent,
      "sess-saved",
      "prompt",
      "/cwd",
      undefined,
      0,
    );

    // Should NOT fall through to invoke — must return the timeout error.
    expect(agent.invoke).not.toHaveBeenCalled();
    expect(out.errorType).toBe("inactivity_timeout");
    expect(out.sessionId).toBe("sess-saved");
  });

  test("auto-resumes timeout from resumed session without losing state", async () => {
    const timeoutResult = makeResult({
      sessionId: "sess-saved",
      status: "error",
      errorType: "inactivity_timeout",
    });
    const successResult = makeResult({
      sessionId: "sess-saved",
      responseText: "recovered",
    });

    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi
        .fn()
        .mockReturnValueOnce(makeStream(timeoutResult))
        .mockReturnValueOnce(makeStream(successResult)),
    };

    const out = await invokeOrResume(
      agent,
      "sess-saved",
      "prompt",
      "/cwd",
      undefined,
      3,
    );

    // Should resume twice (original + retry), never invoke fresh.
    expect(agent.invoke).not.toHaveBeenCalled();
    expect(agent.resume).toHaveBeenCalledTimes(2);
    expect(out.responseText).toBe("recovered");
  });
});

describe("invokeOrResume inactivity auto-resume edge cases", () => {
  test("stops retrying when resume returns non-timeout error", async () => {
    const timeoutResult = makeResult({
      sessionId: "sess-1",
      status: "error",
      errorType: "inactivity_timeout",
    });
    const execError = makeResult({
      sessionId: "sess-1",
      status: "error",
      errorType: "execution_error",
      stderrText: "segfault",
    });

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(timeoutResult)),
      resume: vi.fn().mockReturnValue(makeStream(execError)),
    };

    const out = await invokeOrResume(
      agent,
      undefined,
      "prompt",
      "/cwd",
      undefined,
      3,
    );

    // Should stop after first resume returns execution_error.
    expect(agent.resume).toHaveBeenCalledOnce();
    expect(out.errorType).toBe("execution_error");
  });

  test("uses sessionId from retry result for next retry", async () => {
    const timeout1 = makeResult({
      sessionId: "sess-v1",
      status: "error",
      errorType: "inactivity_timeout",
    });
    const timeout2 = makeResult({
      sessionId: "sess-v2",
      status: "error",
      errorType: "inactivity_timeout",
    });
    const success = makeResult({
      sessionId: "sess-v2",
      responseText: "done",
    });

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(timeout1)),
      resume: vi
        .fn()
        .mockReturnValueOnce(makeStream(timeout2))
        .mockReturnValueOnce(makeStream(success)),
    };

    const out = await invokeOrResume(
      agent,
      undefined,
      "prompt",
      "/cwd",
      undefined,
      3,
    );

    expect(out.responseText).toBe("done");
    // Second resume should use "sess-v2" (from timeout2), not "sess-v1".
    expect(agent.resume).toHaveBeenCalledTimes(2);
    const secondResumeArgs = (agent.resume as ReturnType<typeof vi.fn>).mock
      .calls[1];
    expect(secondResumeArgs[0]).toBe("sess-v2");
  });
});

describe("sendFollowUp inactivity auto-resume edge cases", () => {
  test("uses fallback sessionId when retry result has no sessionId", async () => {
    const timeoutResult = makeResult({
      sessionId: undefined,
      status: "error",
      errorType: "inactivity_timeout",
    });
    const successResult = makeResult({
      sessionId: "sess-orig",
      responseText: "resumed",
    });

    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi
        .fn()
        .mockReturnValueOnce(makeStream(timeoutResult))
        .mockReturnValueOnce(makeStream(successResult)),
    };

    const out = await sendFollowUp(
      agent,
      "sess-orig",
      "prompt",
      "/cwd",
      undefined,
      3,
    );

    expect(out.responseText).toBe("resumed");
    // Retry should use original sessionId "sess-orig" as fallback.
    const retryCall = (agent.resume as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(retryCall[0]).toBe("sess-orig");
  });

  test("stops retrying on non-timeout error during retry", async () => {
    const timeoutResult = makeResult({
      sessionId: "sess-1",
      status: "error",
      errorType: "inactivity_timeout",
    });
    const cliNotFound = makeResult({
      sessionId: undefined,
      status: "error",
      errorType: "cli_not_found",
    });

    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi
        .fn()
        .mockReturnValueOnce(makeStream(timeoutResult))
        .mockReturnValueOnce(makeStream(cliNotFound)),
    };

    const out = await sendFollowUp(
      agent,
      "sess-1",
      "prompt",
      "/cwd",
      undefined,
      3,
    );

    // Should stop after cli_not_found, not retry further.
    expect(agent.resume).toHaveBeenCalledTimes(2);
    expect(out.errorType).toBe("cli_not_found");
  });
});

// ---- mapAgentError for inactivity_timeout -----------------------------------

describe("mapAgentError inactivity_timeout", () => {
  test("maps inactivity_timeout to descriptive message", () => {
    const result = mapAgentError({
      sessionId: undefined,
      responseText: "",
      status: "error",
      errorType: "inactivity_timeout",
      stderrText: "",
    });
    expect(result.outcome).toBe("error");
    expect(result.message).toBe("Agent process timed out due to inactivity.");
  });

  test("includes context with inactivity_timeout", () => {
    const result = mapAgentError(
      {
        sessionId: undefined,
        responseText: "",
        status: "error",
        errorType: "inactivity_timeout",
        stderrText: "",
      },
      "during implementation",
    );
    expect(result.message).toBe(
      "Agent process timed out due to inactivity during implementation.",
    );
  });
});

// ---- buildDocConsistencyInstructions ---------------------------------------

describe("buildDocConsistencyInstructions", () => {
  const text = buildDocConsistencyInstructions();

  test("mentions CHANGELOG", () => {
    expect(text).toContain("CHANGELOG");
  });

  test("mentions documentation site generators", () => {
    expect(text).toContain("MkDocs");
    expect(text).toContain("Sphinx");
    expect(text).toContain("Docusaurus");
    expect(text).toContain("mdBook");
    expect(text).toContain("documentation site generator");
  });

  test("instructs to update source pages, not just the README", () => {
    expect(text).toContain("not just the");
    expect(text).toContain("README");
  });

  test("mentions Keep a Changelog format", () => {
    expect(text).toContain("Keep a Changelog");
  });

  test("mentions manuals", () => {
    expect(text).toContain("manual");
  });

  test("mentions screenshots and placeholders", () => {
    expect(text).toContain("screenshot");
    expect(text).toContain("do not use placeholders");
    expect(text).toContain("retake");
  });

  test("screenshot paragraph comes after doc paragraph", () => {
    const paragraphs = text.split("\n\n");
    expect(paragraphs.length).toBe(2);
    expect(paragraphs[0]).toContain("CHANGELOG");
    expect(paragraphs[1]).toContain("screenshot");
  });

  test("screenshot paragraph does not mention README or CHANGELOG", () => {
    const paragraphs = text.split("\n\n");
    const screenshotParagraph = paragraphs[1];
    expect(screenshotParagraph).not.toContain("README");
    expect(screenshotParagraph).not.toContain("CHANGELOG");
  });

  test("indent parameter prefixes every non-empty line", () => {
    const indented = buildDocConsistencyInstructions("   ");
    const lines = indented.split("\n");
    for (const line of lines) {
      if (line === "") continue;
      expect(line).toMatch(/^ {3}\S/);
    }
  });

  test("indent parameter preserves blank line between paragraphs", () => {
    const indented = buildDocConsistencyInstructions("   ");
    expect(indented).toContain("\n\n");
  });
});
