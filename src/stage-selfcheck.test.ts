import { describe, expect, test, vi } from "vitest";
import type { AgentAdapter, AgentResult, AgentStream } from "./agent.js";
import type { StageContext } from "./pipeline.js";
import {
  buildFixOrDonePrompt,
  buildSelfCheckPrompt,
  createSelfCheckStageHandler,
  type SelfCheckStageOptions,
} from "./stage-selfcheck.js";

// ---- helpers ---------------------------------------------------------------

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    sessionId: "sess-1",
    responseText: "All checks pass.\n\nDONE",
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
  checkResult: AgentResult,
  fixResult?: AgentResult,
): AgentAdapter {
  const invoke = vi.fn().mockReturnValue(makeStream(checkResult));
  const resume = vi.fn().mockReturnValue(makeStream(fixResult ?? checkResult));
  return { invoke, resume };
}

const BASE_CTX: StageContext = {
  owner: "org",
  repo: "repo",
  issueNumber: 42,
  branch: "issue-42",
  worktreePath: "/tmp/wt",
  iteration: 0,
  userInstruction: undefined,
};

function makeOpts(
  overrides: Partial<SelfCheckStageOptions> = {},
): SelfCheckStageOptions {
  return {
    agent: makeAgent(makeResult()),
    issueTitle: "Fix the widget",
    issueBody: "The widget is broken.",
    ...overrides,
  };
}

// ---- buildSelfCheckPrompt --------------------------------------------------

describe("buildSelfCheckPrompt", () => {
  test("includes all 7 review items", () => {
    const prompt = buildSelfCheckPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("1. **Correctness**");
    expect(prompt).toContain("2. **Tests**");
    expect(prompt).toContain("3. **Error handling**");
    expect(prompt).toContain("4. **External services**");
    expect(prompt).toContain("5. **Documentation consistency**");
    expect(prompt).toContain("6. **Security**");
    expect(prompt).toContain("7. **Performance**");
  });

  test("includes repo and issue context", () => {
    const prompt = buildSelfCheckPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("Owner: org");
    expect(prompt).toContain("Repo: repo");
    expect(prompt).toContain("Branch: issue-42");
    expect(prompt).toContain("Issue #42: Fix the widget");
    expect(prompt).toContain("The widget is broken.");
  });

  test("includes user instruction when present", () => {
    const ctx = { ...BASE_CTX, userInstruction: "Focus on tests" };
    const prompt = buildSelfCheckPrompt(ctx, makeOpts());
    expect(prompt).toContain("Additional feedback");
    expect(prompt).toContain("Focus on tests");
  });

  test("omits feedback section when no instruction", () => {
    const prompt = buildSelfCheckPrompt(BASE_CTX, makeOpts());
    expect(prompt).not.toContain("Additional feedback");
  });
});

// ---- buildFixOrDonePrompt --------------------------------------------------

describe("buildFixOrDonePrompt", () => {
  test("mentions FIXED and DONE keywords", () => {
    const prompt = buildFixOrDonePrompt();
    expect(prompt).toContain("FIXED");
    expect(prompt).toContain("DONE");
  });
});

// ---- createSelfCheckStageHandler -------------------------------------------

describe("createSelfCheckStageHandler", () => {
  test("returns stage definition with number 3 and name Self-check", () => {
    const stage = createSelfCheckStageHandler(makeOpts());
    expect(stage.number).toBe(3);
    expect(stage.name).toBe("Self-check");
  });

  // -- two-step flow ---------------------------------------------------------

  test("invokes agent for self-check then resumes for fix-or-done", async () => {
    const checkResult = makeResult({
      sessionId: "sess-check",
      responseText: "Review done.",
    });
    const fixResult = makeResult({ responseText: "All good.\n\nDONE" });
    const agent = makeAgent(checkResult, fixResult);
    const stage = createSelfCheckStageHandler(makeOpts({ agent }));

    await stage.handler(BASE_CTX);

    expect(agent.invoke).toHaveBeenCalledWith(expect.any(String), {
      cwd: "/tmp/wt",
    });
    expect(agent.resume).toHaveBeenCalledWith(
      "sess-check",
      expect.any(String),
      { cwd: "/tmp/wt" },
    );
  });

  test("falls back to invoke when sessionId is undefined", async () => {
    const checkResult = makeResult({ sessionId: undefined });
    const fixResult = makeResult({ responseText: "OK.\n\nDONE" });
    const agent = makeAgent(checkResult, fixResult);
    const invokeResults = [makeStream(checkResult), makeStream(fixResult)];
    let invokeCalls = 0;
    (agent.invoke as ReturnType<typeof vi.fn>).mockImplementation(() => {
      return invokeResults[invokeCalls++];
    });

    const stage = createSelfCheckStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    expect(agent.invoke).toHaveBeenCalledTimes(2);
    expect(agent.resume).not.toHaveBeenCalled();
    expect(result.outcome).toBe("completed");
  });

  // -- outcome mapping: DONE vs FIXED ---------------------------------------

  test("returns completed when agent says DONE", async () => {
    const checkResult = makeResult({ sessionId: "sess-1" });
    const fixResult = makeResult({
      responseText: "Everything is fine.\n\nDONE",
    });
    const agent = makeAgent(checkResult, fixResult);
    const stage = createSelfCheckStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("completed");
  });

  test("returns not_approved when agent says FIXED (triggers loop)", async () => {
    const checkResult = makeResult({ sessionId: "sess-1" });
    const fixResult = makeResult({ responseText: "Fixed the test.\n\nFIXED" });
    const agent = makeAgent(checkResult, fixResult);
    const stage = createSelfCheckStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("not_approved");
  });

  test("returns completed when agent says COMPLETED", async () => {
    const checkResult = makeResult({ sessionId: "sess-1" });
    const fixResult = makeResult({ responseText: "All set.\n\nCOMPLETED" });
    const agent = makeAgent(checkResult, fixResult);
    const stage = createSelfCheckStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("completed");
  });

  test("returns blocked when agent says BLOCKED", async () => {
    const checkResult = makeResult({ sessionId: "sess-1" });
    const fixResult = makeResult({ responseText: "Cannot fix.\n\nBLOCKED" });
    const agent = makeAgent(checkResult, fixResult);
    const stage = createSelfCheckStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("blocked");
  });

  test("returns not_approved on NOT_APPROVED", async () => {
    const checkResult = makeResult({ sessionId: "sess-1" });
    const fixResult = makeResult({
      responseText: "Not right.\n\nNOT_APPROVED",
    });
    const agent = makeAgent(checkResult, fixResult);
    const stage = createSelfCheckStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("not_approved");
  });

  test("returns needs_clarification on ambiguous fix response", async () => {
    const checkResult = makeResult({ sessionId: "sess-1" });
    const fixResult = makeResult({ responseText: "I looked at things." });
    const agent = makeAgent(checkResult, fixResult);
    const stage = createSelfCheckStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("needs_clarification");
  });

  // -- error handling --------------------------------------------------------

  test("returns error when self-check agent call fails (max_turns)", async () => {
    const checkResult = makeResult({
      status: "error",
      errorType: "max_turns",
      responseText: "",
    });
    const agent = makeAgent(checkResult);
    const stage = createSelfCheckStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("maximum turn limit");
    expect(result.message).toContain("self-check");
    expect(agent.resume).not.toHaveBeenCalled();
  });

  test("returns error when self-check fails with stderr", async () => {
    const checkResult = makeResult({
      status: "error",
      errorType: "execution_error",
      stderrText: "timeout",
      responseText: "",
    });
    const agent = makeAgent(checkResult);
    const stage = createSelfCheckStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("timeout");
  });

  test("returns error when fix-or-done agent call fails", async () => {
    const checkResult = makeResult({ sessionId: "sess-1" });
    const fixResult = makeResult({
      status: "error",
      errorType: "execution_error",
      stderrText: "crash",
      responseText: "",
    });
    const agent = makeAgent(checkResult, fixResult);
    const stage = createSelfCheckStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("crash");
    expect(result.message).toContain("during fix");
  });

  test("returns error when fix fails via invoke fallback", async () => {
    const checkResult = makeResult({ sessionId: undefined });
    const fixResult = makeResult({
      status: "error",
      errorType: "max_turns",
      responseText: "",
    });
    const agent = makeAgent(checkResult);
    (agent.invoke as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeStream(checkResult))
      .mockReturnValueOnce(makeStream(fixResult));

    const stage = createSelfCheckStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("during fix");
  });

  // -- message preservation --------------------------------------------------

  test("preserves fix response text in message", async () => {
    const text = "Fixed several issues.\n\nFIXED";
    const checkResult = makeResult({ sessionId: "sess-1" });
    const fixResult = makeResult({ responseText: text });
    const agent = makeAgent(checkResult, fixResult);
    const stage = createSelfCheckStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.message).toBe(text);
  });
});
