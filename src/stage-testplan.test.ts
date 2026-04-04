import { describe, expect, test, vi } from "vitest";
import type { AgentAdapter, AgentResult, AgentStream } from "./agent.js";
import type { StageContext } from "./pipeline.js";
import {
  buildTestPlanSelfCheckPrompt,
  buildTestPlanVerifyPrompt,
  createTestPlanStageHandler,
  type TestPlanStageOptions,
} from "./stage-testplan.js";

// ---- helpers ---------------------------------------------------------------

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    sessionId: "sess-1",
    responseText: "All items verified.\n\nDONE",
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
  verifyResult: AgentResult,
  checkResult?: AgentResult,
): AgentAdapter {
  const invoke = vi.fn().mockReturnValue(makeStream(verifyResult));
  const resume = vi
    .fn()
    .mockReturnValue(makeStream(checkResult ?? verifyResult));
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
    agent: makeAgent(makeResult()),
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
  test("mentions FIXED and DONE keywords", () => {
    const prompt = buildTestPlanSelfCheckPrompt();
    expect(prompt).toContain("FIXED");
    expect(prompt).toContain("DONE");
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

// ---- createTestPlanStageHandler --------------------------------------------

describe("createTestPlanStageHandler", () => {
  test("returns stage definition with number 6 and name", () => {
    const stage = createTestPlanStageHandler(makeOpts());
    expect(stage.number).toBe(6);
    expect(stage.name).toBe("Test plan verification");
  });

  // -- two-step flow ---------------------------------------------------------

  test("invokes agent for verification then resumes for self-check", async () => {
    const verifyResult = makeResult({
      sessionId: "sess-verify",
      responseText: "Verified items.",
    });
    const checkResult = makeResult({ responseText: "All good.\n\nDONE" });
    const agent = makeAgent(verifyResult, checkResult);
    const stage = createTestPlanStageHandler(makeOpts({ agent }));

    await stage.handler(BASE_CTX);

    expect(agent.invoke).toHaveBeenCalledWith(expect.any(String), {
      cwd: "/tmp/wt",
    });
    expect(agent.resume).toHaveBeenCalledWith(
      "sess-verify",
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

  test("returns completed when agent says DONE", async () => {
    const verifyResult = makeResult({ sessionId: "sess-1" });
    const checkResult = makeResult({
      responseText: "Everything is fine.\n\nDONE",
    });
    const agent = makeAgent(verifyResult, checkResult);
    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("completed");
  });

  test("returns not_approved when agent says FIXED (triggers loop)", async () => {
    const verifyResult = makeResult({ sessionId: "sess-1" });
    const checkResult = makeResult({
      responseText: "Fixed a checklist item.\n\nFIXED",
    });
    const agent = makeAgent(verifyResult, checkResult);
    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("not_approved");
  });

  test("returns completed when agent says COMPLETED", async () => {
    const verifyResult = makeResult({ sessionId: "sess-1" });
    const checkResult = makeResult({ responseText: "All set.\n\nCOMPLETED" });
    const agent = makeAgent(verifyResult, checkResult);
    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("completed");
  });

  test("returns blocked when agent says BLOCKED", async () => {
    const verifyResult = makeResult({ sessionId: "sess-1" });
    const checkResult = makeResult({
      responseText: "Cannot verify.\n\nBLOCKED",
    });
    const agent = makeAgent(verifyResult, checkResult);
    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("blocked");
  });

  test("returns not_approved on NOT_APPROVED", async () => {
    const verifyResult = makeResult({ sessionId: "sess-1" });
    const checkResult = makeResult({
      responseText: "Not right.\n\nNOT_APPROVED",
    });
    const agent = makeAgent(verifyResult, checkResult);
    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("not_approved");
  });

  test("returns needs_clarification on ambiguous response", async () => {
    const verifyResult = makeResult({ sessionId: "sess-1" });
    const checkResult = makeResult({ responseText: "I looked at things." });
    const agent = makeAgent(verifyResult, checkResult);
    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("needs_clarification");
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

  // -- message preservation --------------------------------------------------

  test("preserves self-check response text in message", async () => {
    const text = "Fixed several checklist items.\n\nFIXED";
    const verifyResult = makeResult({ sessionId: "sess-1" });
    const checkResult = makeResult({ responseText: text });
    const agent = makeAgent(verifyResult, checkResult);
    const stage = createTestPlanStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.message).toBe(text);
  });
});
