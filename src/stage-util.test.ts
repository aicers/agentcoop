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

  test("falls back to errorType when stderrText is empty", () => {
    const result = mapAgentError({
      ...base,
      errorType: "execution_error",
      stderrText: "",
    });
    expect(result.message).toBe("Agent error: execution_error");
  });

  test("falls back to 'unknown' when both are empty", () => {
    const result = mapAgentError(base);
    expect(result.message).toBe("Agent error: unknown");
  });

  test("includes context with non-max_turns error", () => {
    const result = mapAgentError({ ...base, stderrText: "oops" }, "during fix");
    expect(result.message).toBe("Agent error during fix: oops");
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
});
