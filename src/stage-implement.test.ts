import { describe, expect, test, vi } from "vitest";
import type { AgentAdapter, AgentResult, AgentStream } from "./agent.js";
import type { StageContext } from "./pipeline.js";
import {
  buildCompletionCheckPrompt,
  buildImplementPrompt,
  createImplementStageHandler,
  type ImplementStageOptions,
} from "./stage-implement.js";

// ---- helpers ---------------------------------------------------------------

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    sessionId: "sess-1",
    responseText: "COMPLETED",
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

function makeAgent(
  implResult: AgentResult,
  checkResult?: AgentResult,
): AgentAdapter {
  const invoke = vi.fn().mockReturnValue(makeStream(implResult));
  const resume = vi
    .fn()
    .mockReturnValue(makeStream(checkResult ?? makeResult()));
  return { invoke, resume };
}

const BASE_CTX: StageContext = {
  owner: "org",
  repo: "repo",
  issueNumber: 42,
  branch: "issue-42",
  worktreePath: "/tmp/wt",
  iteration: 0,
  lastAutoIteration: false,
  userInstruction: undefined,
};

function makeOpts(
  overrides: Partial<ImplementStageOptions> = {},
): ImplementStageOptions {
  return {
    agent: makeAgent(makeResult()),
    issueTitle: "Fix the widget",
    issueBody: "The widget is broken.\n\nPlease fix it.",
    ...overrides,
  };
}

// ---- buildImplementPrompt --------------------------------------------------

describe("buildImplementPrompt", () => {
  test("includes repo context", () => {
    const prompt = buildImplementPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("Owner: org");
    expect(prompt).toContain("Repo: repo");
    expect(prompt).toContain("Branch: issue-42");
    // Worktree line is dropped — the agent's cwd is the worktree.
    expect(prompt).not.toContain("Worktree:");
  });

  test("includes issue details", () => {
    const prompt = buildImplementPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("Issue #42: Fix the widget");
    expect(prompt).toContain("The widget is broken.");
  });

  test("includes user instruction when present", () => {
    const ctx = { ...BASE_CTX, userInstruction: "Try a different approach" };
    const prompt = buildImplementPrompt(ctx, makeOpts());
    expect(prompt).toContain("Additional feedback");
    expect(prompt).toContain("Try a different approach");
  });

  test("omits feedback section when no instruction", () => {
    const prompt = buildImplementPrompt(BASE_CTX, makeOpts());
    expect(prompt).not.toContain("Additional feedback");
  });

  test("instructs to start services and run tests against them", () => {
    const prompt = buildImplementPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("Docker Compose");
    expect(prompt).toContain("port");
    expect(prompt).toContain("full test suite");
  });
  test("mentions worktree is based on latest remote default branch", () => {
    const prompt = buildImplementPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("freshly based on the latest");
    expect(prompt).toContain("remote default branch");
  });
});

// ---- buildImplementResumePrompt --------------------------------------------

import { buildImplementResumePrompt } from "./stage-implement.js";

describe("buildImplementResumePrompt", () => {
  test("references issue number without including the full body", () => {
    const prompt = buildImplementResumePrompt(BASE_CTX);
    expect(prompt).toContain("issue #42");
    // Issue body is intentionally omitted on the resume form.
    expect(prompt).not.toContain("The widget is broken.");
    expect(prompt).not.toContain("## Repository");
  });

  test("includes user instruction when present", () => {
    const ctx = { ...BASE_CTX, userInstruction: "Try a different approach" };
    const prompt = buildImplementResumePrompt(ctx);
    expect(prompt).toContain("Additional feedback");
    expect(prompt).toContain("Try a different approach");
  });
});

// ---- buildCompletionCheckPrompt --------------------------------------------

describe("buildCompletionCheckPrompt", () => {
  test("mentions COMPLETED and BLOCKED", () => {
    const prompt = buildCompletionCheckPrompt();
    expect(prompt).toContain("COMPLETED");
    expect(prompt).toContain("BLOCKED");
  });

  test("asks for exactly one keyword", () => {
    const prompt = buildCompletionCheckPrompt();
    expect(prompt).toContain("exactly one");
  });
});

// ---- createImplementStageHandler -------------------------------------------

describe("createImplementStageHandler", () => {
  test("returns stage definition with number 2 and name Implement", () => {
    const stage = createImplementStageHandler(makeOpts());
    expect(stage.number).toBe(2);
    expect(stage.name).toBe("Implement");
  });

  // -- two-step flow ---------------------------------------------------------

  test("invokes agent for implementation then resumes for check", async () => {
    const implResult = makeResult({
      sessionId: "sess-impl",
      responseText: "Code written.",
    });
    const checkResult = makeResult({ responseText: "COMPLETED" });
    const agent = makeAgent(implResult, checkResult);
    const stage = createImplementStageHandler(makeOpts({ agent }));

    await stage.handler(BASE_CTX);

    expect(agent.invoke).toHaveBeenCalledWith(expect.any(String), {
      cwd: "/tmp/wt",
    });
    expect(agent.resume).toHaveBeenCalledWith("sess-impl", expect.any(String), {
      cwd: "/tmp/wt",
    });
  });

  test("throws when implementation returns no sessionId", async () => {
    const implResult = makeResult({
      sessionId: undefined,
      responseText: "Code written.",
    });
    const agent = makeAgent(implResult);

    const stage = createImplementStageHandler(makeOpts({ agent }));
    await expect(stage.handler(BASE_CTX)).rejects.toThrow("no session ID");
  });

  // -- outcome mapping -------------------------------------------------------

  test("returns completed on COMPLETED", async () => {
    const checkResult = makeResult({ responseText: "COMPLETED" });
    const agent = makeAgent(makeResult(), checkResult);
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("completed");
  });

  test("returns blocked on DONE (not in valid keywords)", async () => {
    const checkResult = makeResult({ responseText: "DONE" });
    const agent = makeAgent(makeResult(), checkResult);
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("blocked");
  });

  test("returns blocked on BLOCKED", async () => {
    const checkResult = makeResult({ responseText: "BLOCKED" });
    const agent = makeAgent(makeResult(), checkResult);
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("blocked");
  });

  test("returns blocked on NOT_APPROVED (not in valid keywords)", async () => {
    const checkResult = makeResult({ responseText: "NOT_APPROVED" });
    const agent = makeAgent(makeResult(), checkResult);
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("blocked");
  });

  test("returns blocked on ambiguous check response", async () => {
    const checkResult = makeResult({ responseText: "I think it works." });
    const agent = makeAgent(makeResult(), checkResult);
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("blocked");
  });

  // -- internal clarification retry ------------------------------------------

  test("ambiguous check → internal clarification → completed", async () => {
    const implResult = makeResult({ sessionId: "sess-impl" });
    const ambiguousCheck = makeResult({
      sessionId: "sess-check",
      responseText: "I think it works",
    });
    const clarifiedCheck = makeResult({ responseText: "COMPLETED" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(implResult)),
      resume: vi
        .fn()
        .mockReturnValueOnce(makeStream(ambiguousCheck))
        .mockReturnValueOnce(makeStream(clarifiedCheck)),
    };
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    // (completion check + clarification)
    expect(agent.resume).toHaveBeenCalledTimes(2);
  });

  test("out-of-scope DONE → internal clarification → BLOCKED", async () => {
    const implResult = makeResult({ sessionId: "sess-impl" });
    const outOfScope = makeResult({
      sessionId: "sess-check",
      responseText: "DONE",
    });
    const clarifiedCheck = makeResult({ responseText: "BLOCKED" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(implResult)),
      resume: vi
        .fn()
        .mockReturnValueOnce(makeStream(outOfScope))
        .mockReturnValueOnce(makeStream(clarifiedCheck)),
    };
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("blocked");
    expect(agent.resume).toHaveBeenCalledTimes(2);
  });

  test("ambiguous check → clarification also ambiguous → returns blocked", async () => {
    const implResult = makeResult({ sessionId: "sess-impl" });
    const ambiguousCheck = makeResult({
      sessionId: "sess-check",
      responseText: "Looks OK",
    });
    const stillAmbiguous = makeResult({ responseText: "It is OK" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(implResult)),
      resume: vi
        .fn()
        .mockReturnValueOnce(makeStream(ambiguousCheck))
        .mockReturnValueOnce(makeStream(stillAmbiguous)),
    };
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("blocked");
    expect(agent.resume).toHaveBeenCalledTimes(2);
  });

  test("clarification retry error → returns error", async () => {
    const implResult = makeResult({ sessionId: "sess-impl" });
    const ambiguousCheck = makeResult({
      sessionId: "sess-check",
      responseText: "I think so",
    });
    const errorResult = makeResult({
      status: "error",
      errorType: "execution_error",
      stderrText: "clarify crash",
      responseText: "",
    });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(implResult)),
      resume: vi
        .fn()
        .mockReturnValueOnce(makeStream(ambiguousCheck))
        .mockReturnValueOnce(makeStream(errorResult)),
    };
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("clarify crash");
  });

  test("ambiguous check without sessionId retries via fallback session", async () => {
    const implResult = makeResult({ sessionId: "sess-impl" });
    const noSession = makeResult({
      sessionId: undefined,
      responseText: "I think it works",
    });
    let resumeCall = 0;
    const resumeResults = [
      // 1st resume: ambiguous completion check (no sessionId)
      makeStream(noSession),
      // 2nd resume: clarification retry via fallback session
      makeStream(makeResult({ responseText: "COMPLETED" })),
    ];
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(implResult)),
      resume: vi.fn().mockImplementation(() => resumeResults[resumeCall++]),
    };
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    // Clarification retry succeeds via fallback to "sess-impl".
    expect(result.outcome).toBe("completed");
    expect(agent.resume).toHaveBeenCalledTimes(2);
    expect((agent.resume as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe(
      "sess-impl",
    );
  });

  // -- error handling --------------------------------------------------------

  test("returns error when implementation call fails", async () => {
    const implResult = makeResult({
      status: "error",
      errorType: "max_turns",
      responseText: "",
    });
    const agent = makeAgent(implResult);
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("maximum turn limit");
    expect(agent.resume).not.toHaveBeenCalled();
  });

  test("returns error when completion check call fails", async () => {
    const implResult = makeResult({ sessionId: "sess-1" });
    const checkResult = makeResult({
      status: "error",
      errorType: "execution_error",
      stderrText: "crash",
      responseText: "",
    });
    const agent = makeAgent(implResult, checkResult);
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("crash");
    expect(result.message).toContain("completion check");
  });

  // -- message preservation --------------------------------------------------

  test("preserves check response text in message", async () => {
    const checkResult = makeResult({
      responseText: "Everything looks good.\n\nCOMPLETED",
    });
    const agent = makeAgent(makeResult(), checkResult);
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.message).toBe("Everything looks good.\n\nCOMPLETED");
  });

  // -- session ID reporting ---------------------------------------------------

  test("reports agent session ID via onSessionId callback", async () => {
    const sessionCalls: [string, string][] = [];
    const implResult = makeResult({ sessionId: "sess-impl-42" });
    const agent = makeAgent(implResult);
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const ctx: StageContext = {
      ...BASE_CTX,
      onSessionId: (agent, sid) => sessionCalls.push([agent, sid]),
    };
    await stage.handler(ctx);
    expect(sessionCalls).toEqual([["a", "sess-impl-42"]]);
  });

  test("does not throw when onSessionId is not provided", async () => {
    const agent = makeAgent(makeResult());
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("completed");
  });

  test("resumes saved session when savedAgentASessionId is present", async () => {
    const resumeResult = makeResult({ sessionId: "resumed-sess" });
    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi
        .fn()
        .mockReturnValueOnce(makeStream(resumeResult))
        .mockReturnValueOnce(makeStream(makeResult())),
    };
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const ctx: StageContext = {
      ...BASE_CTX,
      savedAgentASessionId: "old-sess",
    };
    const result = await stage.handler(ctx);
    expect(result.outcome).toBe("completed");
    // Should have called resume (via invokeOrResume), not invoke.
    expect(agent.resume).toHaveBeenCalled();
    expect(agent.resume).toHaveBeenCalledWith("old-sess", expect.any(String), {
      cwd: "/tmp/wt",
    });
  });

  test("prompt sink receives resume: true for completion check", async () => {
    const implResult = makeResult({ sessionId: "sess-impl" });
    const checkResult = makeResult({ responseText: "COMPLETED" });
    const agent = makeAgent(implResult, checkResult);
    const promptSink = vi.fn();
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const ctx: StageContext = {
      ...BASE_CTX,
      promptSinks: { a: promptSink },
    };
    await stage.handler(ctx);

    // First call: implementation prompt (no resume meta).
    expect(promptSink).toHaveBeenCalledTimes(2);
    expect(promptSink.mock.calls[0][2]).toBeUndefined();
    // Second call: completion check (resume: true).
    expect(promptSink.mock.calls[1][2]).toEqual({ resume: true });
  });

  test("prompt sink receives resume: true for clarification retry", async () => {
    const implResult = makeResult({ sessionId: "sess-impl" });
    const ambiguousCheck = makeResult({
      sessionId: "sess-check",
      responseText: "I think so",
    });
    const clarifiedCheck = makeResult({ responseText: "COMPLETED" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(implResult)),
      resume: vi
        .fn()
        .mockReturnValueOnce(makeStream(ambiguousCheck))
        .mockReturnValueOnce(makeStream(clarifiedCheck)),
    };
    const promptSink = vi.fn();
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const ctx: StageContext = {
      ...BASE_CTX,
      promptSinks: { a: promptSink },
    };
    await stage.handler(ctx);

    // 3 calls: impl prompt, check prompt, clarification prompt.
    expect(promptSink).toHaveBeenCalledTimes(3);
    // Both the check and clarification calls pass resume: true.
    expect(promptSink.mock.calls[1][2]).toEqual({ resume: true });
    expect(promptSink.mock.calls[2][2]).toEqual({ resume: true });
  });

  test("falls back to invoke when saved session fails", async () => {
    const errorResult = makeResult({
      status: "error",
      errorType: "unknown",
      stderrText: "expired",
    });
    const freshResult = makeResult({ sessionId: "fresh-sess" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(freshResult)),
      resume: vi
        .fn()
        .mockReturnValueOnce(makeStream(errorResult))
        .mockReturnValueOnce(makeStream(makeResult())),
    };
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const ctx: StageContext = {
      ...BASE_CTX,
      savedAgentASessionId: "expired-sess",
    };
    const result = await stage.handler(ctx);
    expect(result.outcome).toBe("completed");
    // Should have attempted resume, then fallen back to invoke.
    expect(agent.resume).toHaveBeenCalled();
    expect(agent.invoke).toHaveBeenCalled();
  });
});
