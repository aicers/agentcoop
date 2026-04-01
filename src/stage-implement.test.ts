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
    expect(prompt).toContain("Worktree: /tmp/wt");
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

  test("returns completed on DONE", async () => {
    const checkResult = makeResult({ responseText: "DONE" });
    const agent = makeAgent(makeResult(), checkResult);
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("completed");
  });

  test("returns blocked on BLOCKED", async () => {
    const checkResult = makeResult({ responseText: "BLOCKED" });
    const agent = makeAgent(makeResult(), checkResult);
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("blocked");
  });

  test("returns not_approved on NOT_APPROVED", async () => {
    const checkResult = makeResult({ responseText: "NOT_APPROVED" });
    const agent = makeAgent(makeResult(), checkResult);
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("not_approved");
  });

  test("returns needs_clarification on ambiguous check response", async () => {
    const checkResult = makeResult({ responseText: "I think it works." });
    const agent = makeAgent(makeResult(), checkResult);
    const stage = createImplementStageHandler(makeOpts({ agent }));
    const result = await stage.handler(BASE_CTX);
    expect(result.outcome).toBe("needs_clarification");
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
});
