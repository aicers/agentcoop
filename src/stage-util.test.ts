import { describe, expect, test, vi } from "vitest";
import type { AgentAdapter, AgentResult, AgentStream } from "./agent.js";
import {
  invokeOrResume,
  mapAgentError,
  mapFixOrDoneResponse,
  mapParsedStepToResult,
  mapResponseToResult,
  sendFollowUp,
} from "./stage-util.js";

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

  test("uses stderrText when available", () => {
    const result = mapAgentError({
      ...base,
      errorType: "execution_error",
      stderrText: "segfault",
    });
    expect(result.message).toBe("Agent error: segfault");
  });

  test("includes exit code alongside stderrText", () => {
    const result = mapAgentError({
      ...base,
      errorType: "execution_error",
      stderrText: "segfault",
      exitCode: 1,
    });
    expect(result.message).toBe("Agent error: segfault (exit code 1)");
  });

  test("uses responseText when stderrText is empty", () => {
    const result = mapAgentError({
      ...base,
      errorType: "execution_error",
      stderrText: "",
      exitCode: null,
      responseText: "claude exited with code 1",
    });
    expect(result.message).toBe("Agent error: claude exited with code 1");
  });

  test("shows exit code alone when stderr and responseText are empty", () => {
    const result = mapAgentError({
      ...base,
      errorType: "unknown",
      stderrText: "",
      exitCode: 137,
      responseText: "",
    });
    expect(result.message).toBe("Agent error: exit code 137");
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
    // Allow microtask queue to flush for the fire-and-forget drain.
    await new Promise((r) => setTimeout(r, 10));

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
    await new Promise((r) => setTimeout(r, 10));

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
    await new Promise((r) => setTimeout(r, 10));

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

    // drainToSink runs fire-and-forget, so the error is swallowed
    // and .result should still resolve.
    const out = await invokeOrResume(agent, undefined, "prompt", "/cwd", sink);
    await new Promise((r) => setTimeout(r, 10));

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
    await new Promise((r) => setTimeout(r, 10));

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
