import { describe, expect, test, vi } from "vitest";
import type { AgentAdapter, AgentResult, AgentStream } from "./agent.js";
import type { CiRun, CiStatus, CiVerdict } from "./ci.js";
import type { StageContext } from "./pipeline.js";
import {
  buildAuthorCompletionCheckPrompt,
  buildAuthorFixPrompt,
  buildReviewPrompt,
  buildUnresolvedSummaryPrompt,
  createReviewStageHandler,
  type ReviewStageOptions,
} from "./stage-review.js";

// ---- helpers ---------------------------------------------------------------

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    sessionId: "sess-1",
    responseText: "APPROVED",
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

function makeCiRun(overrides: Partial<CiRun> = {}): CiRun {
  return {
    databaseId: 100,
    name: "build",
    status: "completed",
    conclusion: "success",
    headBranch: "issue-42",
    headSha: "abc123",
    ...overrides,
  };
}

function makeCiStatus(verdict: CiVerdict, runs: CiRun[] = []): CiStatus {
  return { verdict, runs };
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
  overrides: Partial<ReviewStageOptions> = {},
): ReviewStageOptions {
  const agentA: AgentAdapter = {
    invoke: vi.fn().mockReturnValue(
      makeStream(
        makeResult({
          sessionId: "sess-a",
          responseText: "Fixed the issues.",
        }),
      ),
    ),
    resume: vi
      .fn()
      .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
  };

  const agentB: AgentAdapter = {
    invoke: vi.fn().mockReturnValue(
      makeStream(
        makeResult({
          sessionId: "sess-b",
          responseText: "Looks good.\n\nAPPROVED",
        }),
      ),
    ),
    resume: vi
      .fn()
      .mockReturnValue(makeStream(makeResult({ responseText: "NONE" }))),
  };

  return {
    agentA,
    agentB,
    issueTitle: "Fix the widget",
    issueBody: "The widget is broken.",
    getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
    collectFailureLogs: vi.fn().mockReturnValue(""),
    getHeadSha: vi.fn().mockReturnValue("abc123"),
    delay: vi.fn().mockResolvedValue(undefined),
    pollIntervalMs: 100,
    pollTimeoutMs: 1000,
    emptyRunsGracePeriodMs: 0,
    ...overrides,
  };
}

// ---- prompt builders ---------------------------------------------------------

describe("buildReviewPrompt", () => {
  test("includes repo and issue context", () => {
    const prompt = buildReviewPrompt(BASE_CTX, makeOpts(), 1);
    expect(prompt).toContain("Owner: org");
    expect(prompt).toContain("Repo: repo");
    expect(prompt).toContain("Issue #42: Fix the widget");
  });

  test("includes round number", () => {
    const prompt = buildReviewPrompt(BASE_CTX, makeOpts(), 2);
    expect(prompt).toContain("[Reviewer Round 2]");
  });

  test("mentions APPROVED and NOT_APPROVED", () => {
    const prompt = buildReviewPrompt(BASE_CTX, makeOpts(), 1);
    expect(prompt).toContain("APPROVED");
    expect(prompt).toContain("NOT_APPROVED");
  });

  test("includes user instruction when present", () => {
    const ctx = { ...BASE_CTX, userInstruction: "Focus on perf" };
    const prompt = buildReviewPrompt(ctx, makeOpts(), 1);
    expect(prompt).toContain("Additional feedback");
    expect(prompt).toContain("Focus on perf");
  });

  test("omits feedback section when no instruction", () => {
    const prompt = buildReviewPrompt(BASE_CTX, makeOpts(), 1);
    expect(prompt).not.toContain("Additional feedback");
  });
});

describe("buildAuthorFixPrompt", () => {
  test("includes round number and instructions", () => {
    const prompt = buildAuthorFixPrompt(BASE_CTX, makeOpts(), 2);
    expect(prompt).toContain("[Reviewer Round 2]");
    expect(prompt).toContain("[Author Round 2]");
    expect(prompt).toContain("Commit and push");
  });
});

describe("buildAuthorCompletionCheckPrompt", () => {
  test("mentions COMPLETED and BLOCKED", () => {
    const prompt = buildAuthorCompletionCheckPrompt();
    expect(prompt).toContain("COMPLETED");
    expect(prompt).toContain("BLOCKED");
  });
});

describe("buildUnresolvedSummaryPrompt", () => {
  test("includes round number and NONE keyword", () => {
    const prompt = buildUnresolvedSummaryPrompt(3);
    expect(prompt).toContain("[Unresolved Round 3]");
    expect(prompt).toContain("NONE");
  });
});

// ---- createReviewStageHandler ------------------------------------------------

describe("createReviewStageHandler", () => {
  test("returns stage definition with number 8 and name Review", () => {
    const stage = createReviewStageHandler(makeOpts());
    expect(stage.number).toBe(8);
    expect(stage.name).toBe("Review");
  });

  // -- approved path ----------------------------------------------------------

  test("returns completed when Agent B approves", async () => {
    const opts = makeOpts();
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("approved");
    expect(result.message).toContain("round 1");
  });

  test("asks B for unresolved summary on approval", async () => {
    const opts = makeOpts();
    const stage = createReviewStageHandler(opts);
    await stage.handler(BASE_CTX);

    // Agent B should have been resumed with the unresolved summary prompt.
    expect(opts.agentB.resume).toHaveBeenCalledWith(
      "sess-b",
      expect.stringContaining("unresolved"),
      { cwd: "/tmp/wt" },
    );
  });

  // -- not approved path ------------------------------------------------------

  test("returns not_approved when B rejects and A fixes with CI pass", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "Needs changes.\n\nNOT_APPROVED",
          }),
        ),
      ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "NONE" }))),
    };

    const opts = makeOpts({ agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("not_approved");
    expect(result.message).toContain("Round 1");
    expect(opts.agentA.invoke).toHaveBeenCalled();
    expect(opts.agentA.resume).toHaveBeenCalled();
  });

  test("invokes Agent A with fix prompt after NOT_APPROVED", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "Issues found.\n\nNOT_APPROVED",
          }),
        ),
      ),
      resume: vi.fn(),
    };

    const opts = makeOpts({ agentB });
    const stage = createReviewStageHandler(opts);
    await stage.handler(BASE_CTX);

    const invokedPrompt = (opts.agentA.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(invokedPrompt).toContain("[Reviewer Round 1]");
    expect(invokedPrompt).toContain("[Author Round 1]");
  });

  // -- round numbering --------------------------------------------------------

  test("uses iteration-based round number", async () => {
    const ctx = { ...BASE_CTX, iteration: 2 };
    const opts = makeOpts();
    const stage = createReviewStageHandler(opts);
    await stage.handler(ctx);

    const invokedPrompt = (opts.agentB.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(invokedPrompt).toContain("[Reviewer Round 3]");
  });

  // -- Agent A blocked --------------------------------------------------------

  test("returns blocked when Agent A reports BLOCKED", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "NOT_APPROVED",
          }),
        ),
      ),
      resume: vi.fn(),
    };

    const agentA: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-a",
            responseText: "Cannot fix this.",
          }),
        ),
      ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "BLOCKED" }))),
    };

    const opts = makeOpts({ agentA, agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("blocked");
    expect(result.message).toContain("Cannot fix this");
  });

  // -- CI failure after fix ---------------------------------------------------

  test("returns error when CI fails after fix attempts exhausted", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "NOT_APPROVED",
          }),
        ),
      ),
      resume: vi.fn(),
    };

    const getCiStatus = vi
      .fn()
      .mockReturnValue(
        makeCiStatus("fail", [
          makeCiRun({ conclusion: "failure", databaseId: 200 }),
        ]),
      );
    const collectFailureLogs = vi.fn().mockReturnValue("test failed");

    // Agent A: first call is fix, subsequent are CI fix attempts
    const invokeResults = [
      makeStream(makeResult({ sessionId: "sess-a", responseText: "Fixed." })),
      makeStream(makeResult({ responseText: "CI fix 1." })),
      makeStream(makeResult({ responseText: "CI fix 2." })),
      makeStream(makeResult({ responseText: "CI fix 3." })),
    ];
    let invokeCall = 0;
    const agentA: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => invokeResults[invokeCall++]),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };

    const opts = makeOpts({
      agentA,
      agentB,
      getCiStatus,
      collectFailureLogs,
      maxFixAttempts: 3,
    });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("still failing");
  });

  // -- error handling ---------------------------------------------------------

  test("returns error when review agent call fails", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            status: "error",
            errorType: "max_turns",
            responseText: "",
          }),
        ),
      ),
      resume: vi.fn(),
    };

    const opts = makeOpts({ agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("maximum turn limit");
    expect(result.message).toContain("review");
  });

  test("returns error when Agent A fix call fails", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "NOT_APPROVED",
          }),
        ),
      ),
      resume: vi.fn(),
    };

    const agentA: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            status: "error",
            errorType: "execution_error",
            stderrText: "crash",
            responseText: "",
          }),
        ),
      ),
      resume: vi.fn(),
    };

    const opts = makeOpts({ agentA, agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("crash");
    expect(result.message).toContain("author fix");
  });

  test("returns error when author completion check fails", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "NOT_APPROVED",
          }),
        ),
      ),
      resume: vi.fn(),
    };

    const agentA: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-a", responseText: "Fixed." }),
          ),
        ),
      resume: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            status: "error",
            errorType: "execution_error",
            stderrText: "timeout",
            responseText: "",
          }),
        ),
      ),
    };

    const opts = makeOpts({ agentA, agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("timeout");
  });

  test("throws when Agent A fix returns no sessionId", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "NOT_APPROVED",
          }),
        ),
      ),
      resume: vi.fn(),
    };

    const agentA: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: undefined, responseText: "Fixed." }),
          ),
        ),
      resume: vi.fn(),
    };

    const opts = makeOpts({ agentA, agentB });
    const stage = createReviewStageHandler(opts);
    await expect(stage.handler(BASE_CTX)).rejects.toThrow("no session ID");
  });

  // -- author completion check: ambiguous → clarification retry ----------------

  test("retries with clarification when author completion check is ambiguous", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "NOT_APPROVED",
          }),
        ),
      ),
      resume: vi.fn(),
    };

    let resumeCall = 0;
    const resumeResults = [
      // First resume: ambiguous
      makeStream(
        makeResult({
          sessionId: "sess-a2",
          responseText: "I addressed the feedback.",
        }),
      ),
      // Second resume: clarified
      makeStream(makeResult({ responseText: "COMPLETED" })),
    ];

    const agentA: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-a", responseText: "Fixed." }),
          ),
        ),
      resume: vi.fn().mockImplementation(() => resumeResults[resumeCall++]),
    };

    const opts = makeOpts({ agentA, agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("not_approved");
    expect(agentA.resume).toHaveBeenCalledTimes(2);

    // The retry prompt must be the stage-specific completion check
    // (COMPLETED/BLOCKED only), not the generic clarification prompt.
    const retryPrompt = (agentA.resume as ReturnType<typeof vi.fn>).mock
      .calls[1][1] as string;
    expect(retryPrompt).toContain("COMPLETED");
    expect(retryPrompt).toContain("BLOCKED");
    expect(retryPrompt).not.toContain("NOT_APPROVED");
  });

  test("ambiguous author check without sessionId skips internal clarification", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "NOT_APPROVED",
          }),
        ),
      ),
      resume: vi.fn(),
    };

    const ambiguousCheck = makeResult({
      sessionId: undefined,
      responseText: "I addressed the feedback.",
    });

    const agentA: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-a", responseText: "Fixed." }),
          ),
        ),
      resume: vi.fn().mockReturnValueOnce(makeStream(ambiguousCheck)),
    };

    const opts = makeOpts({ agentA, agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("needs_clarification");
    expect(agentA.resume).toHaveBeenCalledTimes(1);
  });

  test("returns needs_clarification when author check stays ambiguous after retry", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "NOT_APPROVED",
          }),
        ),
      ),
      resume: vi.fn(),
    };

    let resumeCall = 0;
    const resumeResults = [
      makeStream(
        makeResult({
          sessionId: "sess-a2",
          responseText: "I addressed the feedback.",
        }),
      ),
      makeStream(makeResult({ responseText: "All review items handled." })),
    ];

    const agentA: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-a", responseText: "Fixed." }),
          ),
        ),
      resume: vi.fn().mockImplementation(() => resumeResults[resumeCall++]),
    };

    const opts = makeOpts({ agentA, agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("needs_clarification");
  });

  test("returns error when author clarification retry fails", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "NOT_APPROVED",
          }),
        ),
      ),
      resume: vi.fn(),
    };

    let resumeCall = 0;
    const resumeResults = [
      makeStream(
        makeResult({
          sessionId: "sess-a2",
          responseText: "I addressed the feedback.",
        }),
      ),
      makeStream(
        makeResult({
          status: "error",
          errorType: "execution_error",
          stderrText: "timeout",
          responseText: "",
        }),
      ),
    ];

    const agentA: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-a", responseText: "Fixed." }),
          ),
        ),
      resume: vi.fn().mockImplementation(() => resumeResults[resumeCall++]),
    };

    const opts = makeOpts({ agentA, agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("author completion clarification");
  });

  // -- ambiguous review response -----------------------------------------------

  test("returns needs_clarification on ambiguous review response", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "I looked at the code.",
          }),
        ),
      ),
      resume: vi.fn(),
    };

    const opts = makeOpts({ agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("needs_clarification");
  });

  // -- unresolved summary paths -------------------------------------------------

  test("returns error when unresolved summary agent call fails", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "APPROVED",
          }),
        ),
      ),
      resume: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            status: "error",
            errorType: "execution_error",
            stderrText: "crash",
            responseText: "",
          }),
        ),
      ),
    };

    const opts = makeOpts({ agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("unresolved summary");
  });

  test("includes unresolved items in message when B reports them", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "APPROVED",
          }),
        ),
      ),
      resume: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            responseText:
              "**[Unresolved Round 1]**\n- Error handling in module X\n- Missing test for edge case Y",
          }),
        ),
      ),
    };

    const opts = makeOpts({ agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("Unresolved items:");
    expect(result.message).toContain("Error handling in module X");
  });

  test("omits unresolved section when B responds with NONE", async () => {
    const opts = makeOpts();
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(result.message).not.toContain("Unresolved items:");
    expect(result.message).toContain("Review approved at round 1.");
  });

  test("invokes fresh when sessionId is undefined for unresolved summary", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: undefined,
            responseText: "APPROVED",
          }),
        ),
      ),
      resume: vi.fn(),
    };

    const opts = makeOpts({ agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    // invoke called twice: once for review, once for unresolved summary
    expect(agentB.invoke).toHaveBeenCalledTimes(2);
    expect(agentB.resume).not.toHaveBeenCalled();
  });

  // -- follow-up review prompt ------------------------------------------------

  test("follow-up review prompt includes Author Round reference", () => {
    const prompt = buildReviewPrompt(
      { ...BASE_CTX, iteration: 1 },
      makeOpts(),
      2,
    );
    expect(prompt).toContain("[Author Round 1]");
    expect(prompt).toContain("[Reviewer Round 2]");
  });

  test("first review prompt does not reference Author Round", () => {
    const prompt = buildReviewPrompt(BASE_CTX, makeOpts(), 1);
    expect(prompt).not.toContain("[Author Round");
    expect(prompt).toContain("[Reviewer Round 1]");
  });

  // -- ambiguous does not invoke Agent A --------------------------------------

  test("does not invoke Agent A when review is ambiguous", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "I looked at the code.",
          }),
        ),
      ),
      resume: vi.fn(),
    };

    const opts = makeOpts({ agentB });
    const stage = createReviewStageHandler(opts);
    await stage.handler(BASE_CTX);

    expect(opts.agentA.invoke).not.toHaveBeenCalled();
  });

  // -- getHeadSha forwarding ----------------------------------------------------

  test("forwards getHeadSha to pollCiAndFix and uses SHA in getCiStatus", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "NOT_APPROVED",
          }),
        ),
      ),
      resume: vi.fn(),
    };

    const getCiStatus = vi.fn().mockReturnValue(makeCiStatus("pass"));
    const getHeadSha = vi.fn().mockReturnValue("deadbeef");
    const opts = makeOpts({ agentB, getCiStatus, getHeadSha });
    const stage = createReviewStageHandler(opts);
    await stage.handler(BASE_CTX);

    expect(getHeadSha).toHaveBeenCalledWith("/tmp/wt");
    expect(getCiStatus).toHaveBeenCalledWith(
      "org",
      "repo",
      "issue-42",
      "deadbeef",
    );
  });

  // -- CI timeout during NOT_APPROVED fix flow --------------------------------

  test("returns error when CI times out after Agent A fix", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "NOT_APPROVED",
          }),
        ),
      ),
      resume: vi.fn(),
    };

    const getCiStatus = vi.fn().mockReturnValue(makeCiStatus("pending"));
    let elapsed = 0;
    const startTime = Date.now();
    const delay = vi.fn().mockImplementation(async () => {
      elapsed += 500;
    });
    vi.spyOn(Date, "now").mockImplementation(() => startTime + elapsed);

    const opts = makeOpts({
      agentB,
      getCiStatus,
      delay,
      pollIntervalMs: 100,
      pollTimeoutMs: 1000,
    });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("still pending");

    vi.restoreAllMocks();
  });

  // -- CI passes after fix on second attempt ----------------------------------

  // -- unresolved summary on budget-exhausted NOT_APPROVED ---------------------

  test("requests unresolved summary on NOT_APPROVED when lastAutoIteration is true", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "Needs changes.\n\nNOT_APPROVED",
          }),
        ),
      ),
      resume: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            responseText:
              "**[Unresolved Round 1]**\n- Missing validation in handler",
          }),
        ),
      ),
    };

    const opts = makeOpts({ agentB });
    const stage = createReviewStageHandler(opts);
    const ctx = { ...BASE_CTX, lastAutoIteration: true };
    const result = await stage.handler(ctx);

    expect(result.outcome).toBe("not_approved");
    expect(result.message).toContain("Unresolved items:");
    expect(result.message).toContain("Missing validation in handler");
    expect(agentB.resume).toHaveBeenCalledWith(
      "sess-b",
      expect.stringContaining("unresolved"),
      { cwd: "/tmp/wt" },
    );
  });

  test("skips unresolved summary on NOT_APPROVED when lastAutoIteration is false", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "Needs changes.\n\nNOT_APPROVED",
          }),
        ),
      ),
      resume: vi.fn(),
    };

    const opts = makeOpts({ agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("not_approved");
    expect(result.message).not.toContain("Unresolved items:");
    // Agent B resume should not be called (no unresolved summary request).
    expect(agentB.resume).not.toHaveBeenCalled();
  });

  test("returns error when unresolved summary fails on lastAutoIteration", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "NOT_APPROVED",
          }),
        ),
      ),
      resume: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            status: "error",
            errorType: "execution_error",
            stderrText: "crash",
            responseText: "",
          }),
        ),
      ),
    };

    const opts = makeOpts({ agentB });
    const stage = createReviewStageHandler(opts);
    const ctx = { ...BASE_CTX, lastAutoIteration: true };
    const result = await stage.handler(ctx);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("unresolved summary");
  });

  test("omits unresolved section on NOT_APPROVED lastAutoIteration when B responds NONE", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "NOT_APPROVED",
          }),
        ),
      ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "NONE" }))),
    };

    const opts = makeOpts({ agentB });
    const stage = createReviewStageHandler(opts);
    const ctx = { ...BASE_CTX, lastAutoIteration: true };
    const result = await stage.handler(ctx);

    expect(result.outcome).toBe("not_approved");
    expect(result.message).not.toContain("Unresolved items:");
  });

  test("invokes fresh when sessionId is undefined for unresolved summary on lastAutoIteration", async () => {
    const agentB: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValueOnce(
          makeStream(
            makeResult({
              sessionId: undefined,
              responseText: "NOT_APPROVED",
            }),
          ),
        )
        .mockReturnValueOnce(makeStream(makeResult({ responseText: "NONE" }))),
      resume: vi.fn(),
    };

    const opts = makeOpts({ agentB });
    const stage = createReviewStageHandler(opts);
    const ctx = { ...BASE_CTX, lastAutoIteration: true };
    const result = await stage.handler(ctx);

    expect(result.outcome).toBe("not_approved");
    // invoke called twice: once for review, once for unresolved summary (fresh)
    expect(agentB.invoke).toHaveBeenCalledTimes(2);
    expect(agentB.resume).not.toHaveBeenCalled();
  });

  // -- CI passes after fix on second attempt ----------------------------------

  test("returns not_approved when CI passes after one fix", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "NOT_APPROVED",
          }),
        ),
      ),
      resume: vi.fn(),
    };

    const getCiStatus = vi
      .fn()
      .mockReturnValueOnce(
        makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]),
      )
      .mockReturnValueOnce(makeCiStatus("pass"));
    const collectFailureLogs = vi.fn().mockReturnValue("err");

    const invokeResults = [
      makeStream(makeResult({ sessionId: "sess-a", responseText: "Fixed." })),
      makeStream(makeResult({ responseText: "CI fix." })),
    ];
    let invokeCall = 0;
    const agentA: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => invokeResults[invokeCall++]),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };

    const opts = makeOpts({
      agentA,
      agentB,
      getCiStatus,
      collectFailureLogs,
    });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("not_approved");
    expect(result.message).toContain("Round 1 fixes applied");
  });
});
