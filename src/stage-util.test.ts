import { describe, expect, test, vi } from "vitest";
import type { AgentAdapter, AgentResult, AgentStream } from "./agent.js";
import {
  mapAgentError,
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

  test("invokes fresh when sessionId is undefined", async () => {
    const expected = makeResult({ responseText: "invoked" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(expected)),
      resume: vi.fn(),
    };

    const result = await sendFollowUp(agent, undefined, "prompt", "/cwd");

    expect(agent.invoke).toHaveBeenCalledWith("prompt", { cwd: "/cwd" });
    expect(agent.resume).not.toHaveBeenCalled();
    expect(result.responseText).toBe("invoked");
  });

  test("passes cwd correctly", async () => {
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(makeResult())),
      resume: vi.fn(),
    };

    await sendFollowUp(agent, undefined, "p", "/my/worktree");

    expect(agent.invoke).toHaveBeenCalledWith("p", { cwd: "/my/worktree" });
  });
});
