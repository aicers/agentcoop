import { describe, expect, test, vi } from "vitest";
import type { AgentAdapter, AgentResult, AgentStream } from "./agent.js";
import type { StageContext } from "./pipeline.js";
import {
  buildTestPlanSelfCheckPrompt,
  buildTestPlanVerdictPrompt,
  buildTestPlanVerifyPrompt,
  createTestPlanStageHandler,
  TEST_PLAN_VERDICT_KEYWORDS,
  type TestPlanStageOptions,
} from "./stage-testplan.js";

// ---- helpers ---------------------------------------------------------------

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    sessionId: "sess-1",
    responseText: "All items verified.",
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
 * Create a mock agent that returns the given results in sequence.
 * The first call to `invoke` returns `invokeResult`.
 * Subsequent calls to `resume` return from `resumeResults` in order.
 */
function makeAgent(
  invokeResult: AgentResult,
  ...resumeResults: AgentResult[]
): AgentAdapter {
  const invoke = vi.fn().mockReturnValue(makeStream(invokeResult));
  let resumeCall = 0;
  const resume = vi.fn().mockImplementation(() => {
    const r = resumeResults[resumeCall] ?? invokeResult;
    resumeCall++;
    return makeStream(r);
  });
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
  overrides: Partial<TestPlanStageOptions> = {},
): TestPlanStageOptions {
  return {
    agent: makeAgent(
      makeResult(),
      makeResult(),
      makeResult({ responseText: "DONE" }),
    ),
    issueTitle: "Fix the widget",
    issueBody: "The widget is broken.",
    ...overrides,
  };
}

// ---- buildTestPlanVerifyPrompt ---------------------------------------------

describe("buildTestPlanVerifyPrompt", () => {
  test("includes repo context", () => {
    const prompt = buildTestPlanVerifyPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("Owner: org");
    expect(prompt).toContain("Repo: repo");
    expect(prompt).toContain("Branch: issue-42");
    expect(prompt).toContain("Worktree: /tmp/wt");
  });

  test("includes issue details", () => {
    const prompt = buildTestPlanVerifyPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("Issue #42: Fix the widget");
    expect(prompt).toContain("The widget is broken.");
  });

  test("mentions PR test plan and issue task checklist", () => {
    const prompt = buildTestPlanVerifyPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("Test plan");
    expect(prompt).toContain("task checklist");
  });

  test("instructs to commit and push code changes", () => {
    const prompt = buildTestPlanVerifyPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("commit and push");
  });

  test("instructs to start services using available tools", () => {
    const prompt = buildTestPlanVerifyPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("Docker Compose");
    expect(prompt).toContain("pnpm dev");
    expect(prompt).toContain("setup scripts");
  });

  test("instructs to act as end user for manual test items", () => {
    const prompt = buildTestPlanVerifyPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("do not defer them to the user");
    expect(prompt).toContain("Act as");
    expect(prompt).toContain("Playwright, headless Chrome");
  });

  test("instructs to capture real screenshots instead of placeholders", () => {
    const prompt = buildTestPlanVerifyPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("do not use");
    expect(prompt).toContain("placeholders");
    expect(prompt).toContain("capture real screenshots");
  });

  test("instructs to check parent issue checklists recursively", () => {
    const prompt = buildTestPlanVerifyPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("parent issue");
    expect(prompt).toContain("grandparent, recursively");
  });

  test("includes PR sync instructions before pushing", () => {
    const prompt = buildTestPlanVerifyPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("gh pr view");
    expect(prompt).toContain("gh pr edit");
    expect(prompt).toContain("#42");
  });

  test("includes user instruction when present", () => {
    const ctx = { ...BASE_CTX, userInstruction: "Skip flaky tests" };
    const prompt = buildTestPlanVerifyPrompt(ctx, makeOpts());
    expect(prompt).toContain("Additional feedback");
    expect(prompt).toContain("Skip flaky tests");
  });

  test("omits feedback section when no instruction", () => {
    const prompt = buildTestPlanVerifyPrompt(BASE_CTX, makeOpts());
    expect(prompt).not.toContain("Additional feedback");
  });
});

// ---- buildTestPlanSelfCheckPrompt ------------------------------------------

describe("buildTestPlanSelfCheckPrompt", () => {
  test("mentions fix and done actions without verdict keywords", () => {
    const prompt = buildTestPlanSelfCheckPrompt();
    expect(prompt).toContain("fix them now");
    expect(prompt).toContain("you are done");
    // Should NOT contain the verdict keywords — those are in the verdict prompt
    expect(prompt).not.toContain("FIXED");
    expect(prompt).not.toContain("DONE");
  });

  test("mentions CI status check", () => {
    const prompt = buildTestPlanSelfCheckPrompt();
    expect(prompt).toContain("CI still passing");
  });

  test("instructs to check parent issue checklists recursively", () => {
    const prompt = buildTestPlanSelfCheckPrompt();
    expect(prompt).toContain("parent issue");
    expect(prompt).toContain("grandparent");
  });
});

// ---- buildTestPlanVerdictPrompt --------------------------------------------

describe("buildTestPlanVerdictPrompt", () => {
  test("mentions FIXED and DONE keywords", () => {
    const prompt = buildTestPlanVerdictPrompt();
    expect(prompt).toContain("FIXED");
    expect(prompt).toContain("DONE");
  });
});

// ---- TEST_PLAN_VERDICT_KEYWORDS --------------------------------------------

describe("TEST_PLAN_VERDICT_KEYWORDS", () => {
  test("contains FIXED and DONE", () => {
    expect(TEST_PLAN_VERDICT_KEYWORDS).toContain("FIXED");
    expect(TEST_PLAN_VERDICT_KEYWORDS).toContain("DONE");
  });
});

// ---- createTestPlanStageHandler --------------------------------------------

describe("createTestPlanStageHandler", () => {
  test("returns stage definition with number 6 and name", () => {
    const stage = createTestPlanStageHandler(makeOpts());
    expect(stage.number).toBe(6);
    expect(stage.name).toBe("Test plan verification");
  });

  // -- three-step flow -------------------------------------------------------

  test("invokes agent for verification then resumes for self-check and verdict", async () => {
    const verifyResult = makeResult({
      sessionId: "sess-verify",
      responseText: "Verified items.",
    });
    const checkResult = makeResult({
      sessionId: "sess-check",
      responseText: "All good.",
    });
    const verdictResult = makeResult({
      sessionId: "sess-verdict",
      responseText: "DONE",
    });
    const agent = makeAgent(verifyResult, checkResult, verdictResult);
    const stage = createTestPlanStageHandler(makeOpts({ agent }));

    await stage.handler(BASE_CTX);

    expect(agent.invoke).toHaveBeenCalledWith(expect.any(String), {
      cwd: "/tmp/wt",
    });
    // Two resume calls: self-check work + verdict
    expect(agent.resume).toHaveBeenCalledTimes(2);
    expect(agent.resume).toHaveBeenNthCalledWith(
      1,
      "sess-verify",
      expect.any(String),
      { cwd: "/tmp/wt" },
    );
    expect(agent.resume).toHaveBeenNthCalledWith(
      2,
      "sess-check",
      expect.any(String),
      { cwd: "/tmp/wt" },
    );
  });

  test("throws when verification returns no sessionId", async () => {
    const verifyResult = makeResult({ sessionId: undefined });
    const agent = makeAgent(verifyResult);

    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    await expect(stage.handler(BASE_CTX)).rejects.toThrow("no session ID");
  });

  // -- outcome mapping: DONE vs FIXED ----------------------------------------

  test("returns completed when verdict says DONE", async () => {
    const verifyResult = makeResult({ sessionId: "sess-1" });
    const checkResult = makeResult({
      sessionId: "sess-check",
      responseText: "Everything is fine.",
    });
    const verdictResult = makeResult({ responseText: "DONE" });
    const agent = makeAgent(verifyResult, checkResult, verdictResult);
    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("completed");
  });

  test("returns not_approved when verdict says FIXED (triggers loop)", async () => {
    const verifyResult = makeResult({ sessionId: "sess-1" });
    const checkResult = makeResult({
      sessionId: "sess-check",
      responseText: "Fixed a checklist item.",
    });
    const verdictResult = makeResult({ responseText: "FIXED" });
    const agent = makeAgent(verifyResult, checkResult, verdictResult);
    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("not_approved");
  });

  test("out-of-scope keyword COMPLETED → clarification retry → fallback to not_approved", async () => {
    const verifyResult = makeResult({ sessionId: "sess-1" });
    const checkResult = makeResult({
      sessionId: "sess-check",
      responseText: "All set.",
    });
    const verdictResult = makeResult({ responseText: "COMPLETED" });
    const agent = makeAgent(verifyResult, checkResult, verdictResult);
    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("not_approved");
  });

  test("out-of-scope keyword BLOCKED → clarification retry → fallback to not_approved", async () => {
    const verifyResult = makeResult({ sessionId: "sess-1" });
    const checkResult = makeResult({
      sessionId: "sess-check",
      responseText: "Cannot verify.",
    });
    const verdictResult = makeResult({ responseText: "BLOCKED" });
    const agent = makeAgent(verifyResult, checkResult, verdictResult);
    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("not_approved");
  });

  test("out-of-scope keyword NOT_APPROVED → clarification retry → fallback to not_approved", async () => {
    const verifyResult = makeResult({ sessionId: "sess-1" });
    const checkResult = makeResult({
      sessionId: "sess-check",
      responseText: "Not right.",
    });
    const verdictResult = makeResult({ responseText: "NOT_APPROVED" });
    const agent = makeAgent(verifyResult, checkResult, verdictResult);
    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("not_approved");
  });

  test("ambiguous verdict response → clarification retry → fallback to not_approved", async () => {
    const verifyResult = makeResult({ sessionId: "sess-1" });
    const checkResult = makeResult({
      sessionId: "sess-check",
      responseText: "I looked at things.",
    });
    const verdictResult = makeResult({ responseText: "I looked at things." });
    const agent = makeAgent(verifyResult, checkResult, verdictResult);
    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("not_approved");
  });

  // -- internal clarification retry ------------------------------------------

  test("ambiguous verdict → internal clarification → DONE", async () => {
    const verifyResult = makeResult({ sessionId: "sess-1" });
    const checkResult = makeResult({
      sessionId: "sess-check",
      responseText: "Verified.",
    });
    const verdictResult = makeResult({
      sessionId: "sess-verdict",
      responseText: "I think it looks good",
    });
    const clarifiedResult = makeResult({ responseText: "DONE" });
    const agent = makeAgent(
      verifyResult,
      checkResult,
      verdictResult,
      clarifiedResult,
    );
    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    // (self-check + verdict + clarification)
    expect(agent.resume).toHaveBeenCalledTimes(3);
  });

  test("out-of-scope COMPLETED → internal clarification → FIXED", async () => {
    const verifyResult = makeResult({ sessionId: "sess-1" });
    const checkResult = makeResult({
      sessionId: "sess-check",
      responseText: "Fixed things.",
    });
    const verdictResult = makeResult({
      sessionId: "sess-verdict",
      responseText: "COMPLETED",
    });
    const clarifiedResult = makeResult({ responseText: "FIXED" });
    const agent = makeAgent(
      verifyResult,
      checkResult,
      verdictResult,
      clarifiedResult,
    );
    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("not_approved");
    expect(agent.resume).toHaveBeenCalledTimes(3);
  });

  test("ambiguous verdict → clarification also ambiguous → fallback to not_approved", async () => {
    const verifyResult = makeResult({ sessionId: "sess-1" });
    const checkResult = makeResult({
      sessionId: "sess-check",
      responseText: "Verified.",
    });
    const verdictResult = makeResult({
      sessionId: "sess-verdict",
      responseText: "Looks fine",
    });
    const stillAmbiguous = makeResult({ responseText: "It is fine" });
    const agent = makeAgent(
      verifyResult,
      checkResult,
      verdictResult,
      stillAmbiguous,
    );
    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    // Falls back to not_approved so the pipeline loops (or restarts
    // from an earlier stage) rather than advancing past an uncertain
    // verdict.
    expect(result.outcome).toBe("not_approved");
    expect(agent.resume).toHaveBeenCalledTimes(3);
  });

  test("clarification retry error → returns error", async () => {
    const verifyResult = makeResult({ sessionId: "sess-1" });
    const checkResult = makeResult({
      sessionId: "sess-check",
      responseText: "Verified.",
    });
    const verdictResult = makeResult({
      sessionId: "sess-verdict",
      responseText: "I think so",
    });
    const errorResult = makeResult({
      status: "error",
      errorType: "execution_error",
      stderrText: "clarify crash",
      responseText: "",
    });
    const agent = makeAgent(
      verifyResult,
      checkResult,
      verdictResult,
      errorResult,
    );
    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("clarify crash");
  });

  // -- error handling --------------------------------------------------------

  test("returns error when verify agent call fails (max_turns)", async () => {
    const verifyResult = makeResult({
      status: "error",
      errorType: "max_turns",
      responseText: "",
    });
    const agent = makeAgent(verifyResult);
    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("maximum turn limit");
    expect(result.message).toContain("test plan verification");
    expect(agent.resume).not.toHaveBeenCalled();
  });

  test("returns error when verify fails with stderr", async () => {
    const verifyResult = makeResult({
      status: "error",
      errorType: "execution_error",
      stderrText: "timeout",
      responseText: "",
    });
    const agent = makeAgent(verifyResult);
    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("timeout");
  });

  test("returns error when self-check agent call fails", async () => {
    const verifyResult = makeResult({ sessionId: "sess-1" });
    const checkResult = makeResult({
      status: "error",
      errorType: "execution_error",
      stderrText: "crash",
      responseText: "",
    });
    const agent = makeAgent(verifyResult, checkResult);
    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("crash");
    expect(result.message).toContain("test plan self-check");
  });

  test("returns error when verdict follow-up fails", async () => {
    const verifyResult = makeResult({ sessionId: "sess-1" });
    const checkResult = makeResult({
      sessionId: "sess-check",
      responseText: "Did some work.",
    });
    const verdictResult = makeResult({
      status: "error",
      errorType: "execution_error",
      stderrText: "verdict crash",
      responseText: "",
    });
    const agent = makeAgent(verifyResult, checkResult, verdictResult);
    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("verdict crash");
    expect(result.message).toContain("test plan verdict");
  });

  // -- message preservation --------------------------------------------------

  test("preserves verdict response text in message", async () => {
    const verifyResult = makeResult({ sessionId: "sess-1" });
    const checkResult = makeResult({
      sessionId: "sess-check",
      responseText: "Fixed several checklist items.",
    });
    const verdictResult = makeResult({ responseText: "FIXED" });
    const agent = makeAgent(verifyResult, checkResult, verdictResult);
    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.message).toBe("FIXED");
  });
});
