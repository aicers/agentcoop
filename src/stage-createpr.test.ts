import { describe, expect, test, vi } from "vitest";
import type { AgentAdapter, AgentResult, AgentStream } from "./agent.js";
import type { StageContext } from "./pipeline.js";
import {
  buildCreatePrPrompt,
  buildPrCompletionCheckPrompt,
  type CreatePrStageOptions,
  createCreatePrStageHandler,
} from "./stage-createpr.js";

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
  prResult: AgentResult,
  checkResult?: AgentResult,
): AgentAdapter {
  const invoke = vi.fn().mockReturnValue(makeStream(prResult));
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
  overrides: Partial<CreatePrStageOptions> = {},
): CreatePrStageOptions {
  return {
    agent: makeAgent(makeResult()),
    issueTitle: "Fix the widget",
    issueBody: "The widget is broken.\n\nPlease fix it.",
    ...overrides,
  };
}

// ---- buildCreatePrPrompt ---------------------------------------------------

describe("buildCreatePrPrompt", () => {
  test("includes repo context", () => {
    const prompt = buildCreatePrPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("Owner: org");
    expect(prompt).toContain("Repo: repo");
    expect(prompt).toContain("Branch: issue-42");
    expect(prompt).toContain("Worktree: /tmp/wt");
  });

  test("includes issue details", () => {
    const prompt = buildCreatePrPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("Issue #42: Fix the widget");
    expect(prompt).toContain("The widget is broken.");
  });

  test("instructs to create PR with test plan", () => {
    const prompt = buildCreatePrPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("gh pr create");
    expect(prompt).toContain("Test plan");
  });

  test("includes Closes and Part of issue references", () => {
    const prompt = buildCreatePrPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("Closes #42");
    expect(prompt).toContain("Part of #42");
  });

  test("requires Not addressed section when using Part of", () => {
    const prompt = buildCreatePrPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("Not addressed");
    expect(prompt).toContain("Part of #42");
    expect(prompt).toContain("not implemented and why");
  });

  test("includes user instruction when present", () => {
    const ctx = { ...BASE_CTX, userInstruction: "Use a draft PR" };
    const prompt = buildCreatePrPrompt(ctx, makeOpts());
    expect(prompt).toContain("Additional feedback");
    expect(prompt).toContain("Use a draft PR");
  });

  test("omits feedback section when no instruction", () => {
    const prompt = buildCreatePrPrompt(BASE_CTX, makeOpts());
    expect(prompt).not.toContain("Additional feedback");
  });
});

// ---- buildPrCompletionCheckPrompt ------------------------------------------

describe("buildPrCompletionCheckPrompt", () => {
  test("mentions COMPLETED and BLOCKED", () => {
    const prompt = buildPrCompletionCheckPrompt();
    expect(prompt).toContain("COMPLETED");
    expect(prompt).toContain("BLOCKED");
  });

  test("asks for exactly one keyword", () => {
    const prompt = buildPrCompletionCheckPrompt();
    expect(prompt).toContain("exactly one");
  });

  test("asks for just the keyword with no other commentary", () => {
    const prompt = buildPrCompletionCheckPrompt();
    expect(prompt).toContain("BLOCKED");
    expect(prompt).toContain("Do not include any other commentary");
  });
});

// ---- createCreatePrStageHandler --------------------------------------------

describe("createCreatePrStageHandler", () => {
  test("returns stage definition with number 4 and name Create PR", () => {
    const stage = createCreatePrStageHandler(makeOpts());
    expect(stage.number).toBe(4);
    expect(stage.name).toBe("Create PR");
  });

  test("sets requiresArtifact to true", () => {
    const stage = createCreatePrStageHandler(makeOpts());
    expect(stage.requiresArtifact).toBe(true);
  });

  // -- two-step flow ---------------------------------------------------------

  test("invokes agent for PR creation then resumes for check", async () => {
    const prResult = makeResult({
      sessionId: "sess-pr",
      responseText: "PR created.",
    });
    const checkResult = makeResult({ responseText: "COMPLETED" });
    const agent = makeAgent(prResult, checkResult);
    const stage = createCreatePrStageHandler(makeOpts({ agent }));

    await stage.handler(BASE_CTX);

    expect(agent.invoke).toHaveBeenCalledWith(expect.any(String), {
      cwd: "/tmp/wt",
    });
    expect(agent.resume).toHaveBeenCalledWith("sess-pr", expect.any(String), {
      cwd: "/tmp/wt",
    });
  });

  test("throws when PR creation returns no sessionId", async () => {
    const prResult = makeResult({
      sessionId: undefined,
      responseText: "PR created.",
    });
    const agent = makeAgent(prResult);

    const stage = createCreatePrStageHandler(makeOpts({ agent }));
    await expect(stage.handler(BASE_CTX)).rejects.toThrow("no session ID");
  });

  // -- outcome mapping -------------------------------------------------------

  test("returns completed on COMPLETED", async () => {
    const checkResult = makeResult({ responseText: "COMPLETED" });
    const agent = makeAgent(makeResult(), checkResult);
    const stage = createCreatePrStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("completed");
  });

  test("proceeds as completed on DONE (not in valid keywords) when PR exists", async () => {
    const checkResult = makeResult({ responseText: "DONE" });
    const agent = makeAgent(makeResult(), checkResult);
    const findPrNumber = vi.fn().mockReturnValue(99);
    const stage = createCreatePrStageHandler(makeOpts({ agent, findPrNumber }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("completed");
  });

  test("returns blocked on BLOCKED", async () => {
    const checkResult = makeResult({ responseText: "BLOCKED" });
    const agent = makeAgent(makeResult(), checkResult);
    const stage = createCreatePrStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("blocked");
  });

  test("blocked message includes step 1 diagnostic text", async () => {
    const prResult = makeResult({
      sessionId: "sess-pr",
      responseText: "Push failed: permission denied to push to main.",
    });
    const checkResult = makeResult({ responseText: "BLOCKED" });
    const agent = makeAgent(prResult, checkResult);
    const stage = createCreatePrStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("blocked");
    expect(result.message).toContain("permission denied");
    expect(result.message).toContain("BLOCKED");
  });

  test("proceeds as completed on NOT_APPROVED (not in valid keywords) when PR exists", async () => {
    const checkResult = makeResult({ responseText: "NOT_APPROVED" });
    const agent = makeAgent(makeResult(), checkResult);
    const findPrNumber = vi.fn().mockReturnValue(99);
    const stage = createCreatePrStageHandler(makeOpts({ agent, findPrNumber }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("completed");
  });

  test("ambiguous check → internal clarification → completed", async () => {
    const prResult = makeResult({ sessionId: "sess-pr" });
    const ambiguousCheck = makeResult({
      sessionId: "sess-check",
      responseText: "I think it worked.",
    });
    const clarifiedCheck = makeResult({ responseText: "COMPLETED" });

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(prResult)),
      resume: vi
        .fn()
        .mockReturnValueOnce(makeStream(ambiguousCheck))
        .mockReturnValueOnce(makeStream(clarifiedCheck)),
    };

    const stage = createCreatePrStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    // invoke called once (PR creation), resume called twice
    // (completion check + clarification)
    expect(agent.invoke).toHaveBeenCalledTimes(1);
    expect(agent.resume).toHaveBeenCalledTimes(2);
  });

  test("ambiguous check → clarification also ambiguous → completed when PR exists", async () => {
    const prResult = makeResult({ sessionId: "sess-pr" });
    const ambiguousCheck = makeResult({
      sessionId: "sess-check",
      responseText: "I think it worked.",
    });
    const stillAmbiguous = makeResult({
      responseText: "I think so maybe.",
    });

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(prResult)),
      resume: vi
        .fn()
        .mockReturnValueOnce(makeStream(ambiguousCheck))
        .mockReturnValueOnce(makeStream(stillAmbiguous)),
    };

    const findPrNumber = vi.fn().mockReturnValue(99);
    const stage = createCreatePrStageHandler(makeOpts({ agent, findPrNumber }));
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(findPrNumber).toHaveBeenCalledWith("org", "repo", "issue-42");
  });

  test("ambiguous check → clarification also ambiguous → blocked when no PR exists", async () => {
    const prResult = makeResult({
      sessionId: "sess-pr",
      responseText: "I tried to create the PR.",
    });
    const ambiguousCheck = makeResult({
      sessionId: "sess-check",
      responseText: "I think it worked.",
    });
    const stillAmbiguous = makeResult({
      responseText: "I think so maybe.",
    });

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(prResult)),
      resume: vi
        .fn()
        .mockReturnValueOnce(makeStream(ambiguousCheck))
        .mockReturnValueOnce(makeStream(stillAmbiguous)),
    };

    const findPrNumber = vi.fn().mockReturnValue(undefined);
    const stage = createCreatePrStageHandler(makeOpts({ agent, findPrNumber }));
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("blocked");
    expect(result.message).toContain("I tried to create the PR.");
  });

  test("ambiguous check without sessionId retries via fallback session", async () => {
    const prResult = makeResult({ sessionId: "sess-pr" });
    const ambiguousCheck = makeResult({
      sessionId: undefined,
      responseText: "I think it worked.",
    });

    let resumeCall = 0;
    const resumeResults = [
      // 1st resume: ambiguous completion check (no sessionId)
      makeStream(ambiguousCheck),
      // 2nd resume: clarification retry via fallback session
      makeStream(makeResult({ responseText: "COMPLETED" })),
    ];

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(prResult)),
      resume: vi.fn().mockImplementation(() => resumeResults[resumeCall++]),
    };

    const stage = createCreatePrStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    // Clarification retry succeeds via fallback to "sess-pr".
    expect(result.outcome).toBe("completed");
    expect(agent.resume).toHaveBeenCalledTimes(2);
    expect((agent.resume as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe(
      "sess-pr",
    );
  });

  // -- error handling --------------------------------------------------------

  test("returns error when PR creation call fails", async () => {
    const prResult = makeResult({
      status: "error",
      errorType: "max_turns",
      responseText: "",
    });
    const agent = makeAgent(prResult);
    const stage = createCreatePrStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("maximum turn limit");
    expect(agent.resume).not.toHaveBeenCalled();
  });

  test("returns error when completion check call fails", async () => {
    const prResult = makeResult({ sessionId: "sess-1" });
    const checkResult = makeResult({
      status: "error",
      errorType: "execution_error",
      stderrText: "crash",
      responseText: "",
    });
    const agent = makeAgent(prResult, checkResult);
    const stage = createCreatePrStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("crash");
    expect(result.message).toContain("PR completion check");
  });

  // -- message preservation --------------------------------------------------

  test("preserves check response text in message", async () => {
    const checkResult = makeResult({
      responseText: "PR #99 created successfully.\n\nCOMPLETED",
    });
    const agent = makeAgent(makeResult(), checkResult);
    const findPrNumber = vi.fn().mockReturnValue(99);
    const stage = createCreatePrStageHandler(makeOpts({ agent, findPrNumber }));
    const result = await stage.handler(BASE_CTX);
    expect(result.message).toBe("PR #99 created successfully.\n\nCOMPLETED");
  });
});
