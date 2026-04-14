import { describe, expect, test, vi } from "vitest";
import type { AgentAdapter, AgentResult, AgentStream } from "./agent.js";
import type { CiRun, CiStatus, CiVerdict } from "./ci.js";
import type { StageContext } from "./pipeline.js";
import {
  buildAuthorCompletionCheckPrompt,
  buildAuthorFixPrompt,
  buildPrFinalizationPrompt,
  buildPrFinalizationVerdictPrompt,
  buildResumeUnresolvedSummaryPrompt,
  buildReviewPrompt,
  buildReviewVerdictPrompt,
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
    source: "workflow",
    ...overrides,
  };
}

function makeCiStatus(verdict: CiVerdict, runs: CiRun[] = []): CiStatus {
  return { verdict, runs, findings: [] };
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
          responseText: "I verified the PR body.",
        }),
      ),
    ),
    resume: vi
      .fn()
      .mockReturnValue(
        makeStream(makeResult({ responseText: "PR_FINALIZED" })),
      ),
  };

  const agentB: AgentAdapter = {
    invoke: vi.fn().mockReturnValue(
      makeStream(
        makeResult({
          sessionId: "sess-b",
          responseText: "Looks good.",
        }),
      ),
    ),
    resume: vi
      .fn()
      // 1st resume: review verdict
      .mockReturnValueOnce(makeStream(makeResult({ responseText: "APPROVED" })))
      // 2nd resume: unresolved summary
      .mockReturnValueOnce(
        makeStream(makeResult({ responseText: "Summary text" })),
      )
      // 3rd resume: unresolved verdict
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
    postPrComment: vi.fn(),
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

  test("review prompt no longer contains verdict keywords", () => {
    const prompt = buildReviewPrompt(BASE_CTX, makeOpts(), 1);
    expect(prompt).not.toContain("APPROVED");
    expect(prompt).not.toContain("NOT_APPROVED");
  });

  test("verdict prompt mentions APPROVED and NOT_APPROVED", () => {
    const prompt = buildReviewVerdictPrompt();
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

  test("round 1 includes shared review-angles block", () => {
    const prompt = buildReviewPrompt(BASE_CTX, makeOpts(), 1);
    // At least one distinctive phrase per angle:
    expect(prompt).toContain("implemented in a surprising way");
    expect(prompt).toContain("edge cases and failure paths");
    expect(prompt).toContain("over-engineering");
    expect(prompt).toContain("do NOT need to run the test");
    expect(prompt).toContain("input validation, injection");
    expect(prompt).toContain("out of sync with");
    expect(prompt).toContain("PR hygiene");
    expect(prompt).toContain("guidance, not a limit");
  });

  test("round 2+ includes shared review-angles block", () => {
    const prompt = buildReviewPrompt(
      { ...BASE_CTX, iteration: 1 },
      makeOpts(),
      2,
    );
    expect(prompt).toContain("implemented in a surprising way");
    expect(prompt).toContain("edge cases and failure paths");
    expect(prompt).toContain("over-engineering");
    expect(prompt).toContain("do NOT need to run the test");
    expect(prompt).toContain("input validation, injection");
    expect(prompt).toContain("out of sync with");
    expect(prompt).toContain("PR hygiene");
    expect(prompt).toContain("guidance, not a limit");
  });

  test("round 2+ includes follow-through and reasoned-pushback wording", () => {
    const prompt = buildReviewPrompt(
      { ...BASE_CTX, iteration: 1 },
      makeOpts(),
      2,
    );
    expect(prompt).toContain("verify that the fix is");
    expect(prompt).toContain("pushed back with reasoning");
    expect(prompt).toContain("genuinely unresolved");
  });

  test("both rounds include citation guidance", () => {
    const round1 = buildReviewPrompt(BASE_CTX, makeOpts(), 1);
    const round2 = buildReviewPrompt(
      { ...BASE_CTX, iteration: 1 },
      makeOpts(),
      2,
    );
    for (const prompt of [round1, round2]) {
      expect(prompt).toContain("when they help");
      expect(prompt).toContain("appropriate level");
    }
  });

  test("both rounds frame review as independent judgment", () => {
    const round1 = buildReviewPrompt(BASE_CTX, makeOpts(), 1);
    const round2 = buildReviewPrompt(
      { ...BASE_CTX, iteration: 1 },
      makeOpts(),
      2,
    );
    for (const prompt of [round1, round2]) {
      expect(prompt).toContain("independent judgment");
      expect(prompt).toContain("not a mechanical checklist");
    }
  });
});

describe("buildAuthorFixPrompt", () => {
  test("includes round number and instructions", () => {
    const prompt = buildAuthorFixPrompt(BASE_CTX, makeOpts(), 2);
    expect(prompt).toContain("[Reviewer Round 2]");
    expect(prompt).toContain("[Author Round 2]");
    expect(prompt).toContain("Commit and push");
  });

  test("instructs critical evaluation of review items", () => {
    const prompt = buildAuthorFixPrompt(BASE_CTX, makeOpts(), 1);
    expect(prompt).toContain("Evaluate each review item");
    expect(prompt).toContain("Accept and fix");
    expect(prompt).toContain("Push back with reasoning");
    expect(prompt).toContain("Partially address");
    expect(prompt).toContain("do not apply them blindly");
  });

  test("requires clear disposition for each item in author comment", () => {
    const prompt = buildAuthorFixPrompt(BASE_CTX, makeOpts(), 1);
    expect(prompt).toContain("**Fixed**");
    expect(prompt).toContain("**Pushed back**");
    expect(prompt).toContain("**Partially addressed**");
  });

  test("includes doc consistency instructions with screenshots", () => {
    const prompt = buildAuthorFixPrompt(BASE_CTX, makeOpts(), 1);
    expect(prompt).toContain("CHANGELOG");
    expect(prompt).toContain("MkDocs");
    expect(prompt).toContain("retake");
    expect(prompt).toContain("screenshots");
  });

  test("step numbers are correctly ordered", () => {
    const prompt = buildAuthorFixPrompt(BASE_CTX, makeOpts(), 1);
    // Verify the 7 steps appear in order. Extract step numbers.
    const stepNumbers = [...prompt.matchAll(/^(\d+)\.\s/gm)].map((m) =>
      Number(m[1]),
    );
    expect(stepNumbers).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(prompt).toContain("7. Commit and push");
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
  test("includes round number and does not contain verdict keywords", () => {
    const prompt = buildUnresolvedSummaryPrompt(3);
    expect(prompt).toContain("[Reviewer Unresolved Round 3]");
    // Work prompt must not contain verdict keywords — those belong
    // in the dedicated verdict follow-up.
    expect(prompt).not.toContain("NONE");
    expect(prompt).not.toContain("COMPLETED");
  });
});

describe("buildResumeUnresolvedSummaryPrompt", () => {
  test("includes repo context and instructs B to read its review", () => {
    const prompt = buildResumeUnresolvedSummaryPrompt(BASE_CTX, 2);
    expect(prompt).toContain("Owner: org");
    expect(prompt).toContain("Repo: repo");
    expect(prompt).toContain("Branch: issue-42");
    expect(prompt).toContain("[Reviewer Round 2]");
    expect(prompt).toContain("[Reviewer Unresolved Round 2]");
  });
});

describe("buildPrFinalizationPrompt", () => {
  test("includes repo and issue context", () => {
    const prompt = buildPrFinalizationPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("Owner: org");
    expect(prompt).toContain("Repo: repo");
    expect(prompt).toContain("Issue #42: Fix the widget");
  });

  test("mentions Closes, Part of, and Not addressed", () => {
    const prompt = buildPrFinalizationPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("Closes #42");
    expect(prompt).toContain("Part of #42");
    expect(prompt).toContain("Not addressed");
  });

  test("instructs to read and update PR body", () => {
    const prompt = buildPrFinalizationPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("gh pr view --json body");
    expect(prompt).toContain("gh pr edit --body");
  });

  test("finalization prompt no longer contains PR_FINALIZED", () => {
    const prompt = buildPrFinalizationPrompt(BASE_CTX, makeOpts());
    expect(prompt).not.toContain("PR_FINALIZED");
  });

  test("finalization verdict prompt mentions PR_FINALIZED", () => {
    const prompt = buildPrFinalizationVerdictPrompt();
    expect(prompt).toContain("PR_FINALIZED");
  });
});

// ---- createReviewStageHandler ------------------------------------------------

describe("createReviewStageHandler", () => {
  test("returns stage definition with number 7 and name Review", () => {
    const stage = createReviewStageHandler(makeOpts());
    expect(stage.number).toBe(7);
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

    // 1st resume: review verdict, 2nd resume: unresolved summary.
    const calls = (opts.agentB.resume as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1][1]).toContain("unresolved");
  });

  // -- not approved path ------------------------------------------------------

  test("returns not_approved when B rejects and A fixes with CI pass", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "Needs changes.",
          }),
        ),
      ),
      // 1st resume: review verdict (NOT_APPROVED)
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
    };

    const agentA: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-a",
            responseText: "Fixed.",
          }),
        ),
      ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };

    const opts = makeOpts({ agentA, agentB });
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
            responseText: "Issues found.",
          }),
        ),
      ),
      // 1st resume: review verdict (NOT_APPROVED)
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
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
      // 1st resume: review verdict
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
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
      // 1st resume: review verdict
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
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
      // 1st resume: review verdict
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
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
      // 1st resume: review verdict
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
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
      // 1st resume: review verdict
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
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
      // 1st resume: review verdict
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
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

    // The retry prompt uses buildClarificationPrompt with
    // AUTHOR_CHECK_KEYWORDS (COMPLETED/BLOCKED), not the generic one.
    const retryPrompt = (agentA.resume as ReturnType<typeof vi.fn>).mock
      .calls[1][1] as string;
    expect(retryPrompt).toContain("COMPLETED");
    expect(retryPrompt).toContain("BLOCKED");
    expect(retryPrompt).not.toContain("NOT_APPROVED");
  });

  test("ambiguous author check without sessionId retries via fallback session", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "NOT_APPROVED",
          }),
        ),
      ),
      // 1st resume: review verdict
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
    };

    const ambiguousCheck = makeResult({
      sessionId: undefined,
      responseText: "I addressed the feedback.",
    });

    let aResumeCall = 0;
    const aResumeResults = [
      // 1st resume: ambiguous completion check (no sessionId)
      makeStream(ambiguousCheck),
      // 2nd resume: clarification retry via fallback session
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
      resume: vi.fn().mockImplementation(() => aResumeResults[aResumeCall++]),
    };

    const opts = makeOpts({ agentA, agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    // Clarification retry succeeds via fallback to "sess-a".
    expect(result.outcome).toBe("not_approved");
    expect(agentA.resume).toHaveBeenCalledTimes(2);
    // The retry used the invoke session as fallback.
    expect((agentA.resume as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe(
      "sess-a",
    );
  });

  test("returns blocked when author check stays ambiguous after retry", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "NOT_APPROVED",
          }),
        ),
      ),
      // 1st resume: review verdict
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
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

    // Surfaces a blocked condition so the user can decide how to
    // proceed, rather than polling stale CI on an unchanged head.
    expect(result.outcome).toBe("blocked");
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
      // 1st resume: review verdict
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
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

  test("returns needs_clarification on ambiguous review verdict", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "I looked at the code.",
          }),
        ),
      ),
      // 1st resume: ambiguous verdict, 2nd resume: still ambiguous after clarification
      resume: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b2",
            responseText: "I think it looks fine.",
          }),
        ),
      ),
    };

    const opts = makeOpts({ agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("needs_clarification");
  });

  test("ambiguous review verdict → clarification retry → APPROVED completes", async () => {
    let bResumeCall = 0;
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "Looks good.",
          }),
        ),
      ),
      resume: vi.fn().mockImplementation(() => {
        bResumeCall++;
        if (bResumeCall === 1) {
          // 1st resume: ambiguous verdict
          return makeStream(
            makeResult({
              sessionId: "sess-b2",
              responseText: "I think it is fine.",
            }),
          );
        }
        if (bResumeCall === 2) {
          // 2nd resume: clarification → APPROVED
          return makeStream(makeResult({ responseText: "APPROVED" }));
        }
        if (bResumeCall === 3) {
          // 3rd resume: unresolved summary
          return makeStream(
            makeResult({ responseText: "No unresolved items." }),
          );
        }
        // 4th resume: unresolved verdict
        return makeStream(makeResult({ responseText: "NONE" }));
      }),
    };

    const opts = makeOpts({ agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    // Clarification retry was attempted (3rd call = clarification, not unresolved)
    expect(agentB.resume).toHaveBeenCalledTimes(4);
  });

  test("ambiguous review verdict → clarification retry → NOT_APPROVED triggers fix loop", async () => {
    let bResumeCall = 0;
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "Needs work.",
          }),
        ),
      ),
      resume: vi.fn().mockImplementation(() => {
        bResumeCall++;
        if (bResumeCall === 1) {
          // 1st resume: ambiguous verdict
          return makeStream(
            makeResult({ sessionId: "sess-b2", responseText: "Hmm not sure" }),
          );
        }
        // 2nd resume: clarification → NOT_APPROVED
        return makeStream(makeResult({ responseText: "NOT_APPROVED" }));
      }),
    };

    // Agent A must handle the fix loop after NOT_APPROVED.
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

    const opts = makeOpts({ agentA, agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("not_approved");
  });

  test("out-of-scope keyword in review verdict triggers clarification → APPROVED", async () => {
    let bResumeCall = 0;
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "Looks good.",
          }),
        ),
      ),
      resume: vi.fn().mockImplementation(() => {
        bResumeCall++;
        if (bResumeCall === 1) {
          // 1st resume: out-of-scope keyword COMPLETED
          return makeStream(
            makeResult({ sessionId: "sess-b2", responseText: "COMPLETED" }),
          );
        }
        if (bResumeCall === 2) {
          // 2nd resume: clarification → APPROVED
          return makeStream(makeResult({ responseText: "APPROVED" }));
        }
        if (bResumeCall === 3) {
          // 3rd resume: unresolved summary
          return makeStream(
            makeResult({ responseText: "Nothing unresolved." }),
          );
        }
        // 4th resume: unresolved verdict
        return makeStream(makeResult({ responseText: "NONE" }));
      }),
    };

    const opts = makeOpts({ agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(agentB.resume).toHaveBeenCalledTimes(4);
  });

  test("returns error when review verdict clarification retry fails", async () => {
    let bResumeCall = 0;
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "Looks good.",
          }),
        ),
      ),
      resume: vi.fn().mockImplementation(() => {
        bResumeCall++;
        if (bResumeCall === 1) {
          // 1st resume: ambiguous verdict
          return makeStream(
            makeResult({ sessionId: "sess-b2", responseText: "I think so" }),
          );
        }
        // 2nd resume: clarification error
        return makeStream(
          makeResult({
            status: "error",
            errorType: "execution_error",
            stderrText: "crash",
            responseText: "",
          }),
        );
      }),
    };

    const opts = makeOpts({ agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("review verdict clarification");
  });

  test("ambiguous fresh verdict without sessionId invokes B fresh for clarification", async () => {
    // Regression: when B is invoked fresh for the verdict (no prior
    // session) and returns an ambiguous response without a sessionId,
    // the clarification retry must invoke fresh again instead of
    // crashing with "no session ID".
    const agentB: AgentAdapter = {
      invoke: vi
        .fn()
        // 1st invoke: review (returns no sessionId)
        .mockReturnValueOnce(
          makeStream(
            makeResult({
              sessionId: undefined,
              responseText: "Some review text.",
            }),
          ),
        )
        // 2nd invoke: fresh verdict (ambiguous, no sessionId)
        .mockReturnValueOnce(
          makeStream(
            makeResult({
              sessionId: undefined,
              responseText: "I think it looks okay.",
            }),
          ),
        )
        // 3rd invoke: fresh clarification → APPROVED
        .mockReturnValueOnce(
          makeStream(
            makeResult({
              sessionId: "sess-b-fresh",
              responseText: "APPROVED",
            }),
          ),
        )
        // subsequent invokes: unresolved summary + verdict
        .mockReturnValue(makeStream(makeResult({ responseText: "NONE" }))),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "NONE" }))),
    };

    const opts = makeOpts({ agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    // Should complete without throwing "no session ID".
    expect(result.outcome).toBe("completed");
    // B.invoke called at least 3 times: review, fresh verdict,
    // fresh clarification.
    expect(
      (agentB.invoke as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThanOrEqual(3);
  });

  // -- PR finalization clarification paths ----------------------------------------

  test("ambiguous finalization verdict → clarification → PR_FINALIZED completes", async () => {
    let aResumeCall = 0;
    const agentA: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-a",
            responseText: "I verified the PR body.",
          }),
        ),
      ),
      resume: vi.fn().mockImplementation(() => {
        aResumeCall++;
        if (aResumeCall === 1) {
          // 1st resume: ambiguous verdict
          return makeStream(
            makeResult({
              sessionId: "sess-a2",
              responseText: "Done updating.",
            }),
          );
        }
        // 2nd resume: clarification → PR_FINALIZED
        return makeStream(makeResult({ responseText: "PR_FINALIZED" }));
      }),
    };

    const opts = makeOpts({ agentA });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
  });

  test("returns error when finalization clarification retry fails", async () => {
    let aResumeCall = 0;
    const agentA: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-a",
            responseText: "I verified the PR body.",
          }),
        ),
      ),
      resume: vi.fn().mockImplementation(() => {
        aResumeCall++;
        if (aResumeCall === 1) {
          // 1st resume: ambiguous verdict
          return makeStream(
            makeResult({ sessionId: "sess-a2", responseText: "Updated it." }),
          );
        }
        // 2nd resume: clarification error
        return makeStream(
          makeResult({
            status: "error",
            errorType: "execution_error",
            stderrText: "crash",
            responseText: "",
          }),
        );
      }),
    };

    const opts = makeOpts({ agentA });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("PR finalization clarification");
  });

  // -- unresolved summary paths -------------------------------------------------

  test("returns error when unresolved summary agent call fails", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "Looks good.",
          }),
        ),
      ),
      resume: vi
        .fn()
        // 1st resume: review verdict (APPROVED)
        .mockReturnValueOnce(
          makeStream(makeResult({ responseText: "APPROVED" })),
        )
        // 2nd resume: unresolved summary (error)
        .mockReturnValue(
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
            responseText: "Looks good.",
          }),
        ),
      ),
      resume: vi
        .fn()
        // 1st resume: review verdict (APPROVED)
        .mockReturnValueOnce(
          makeStream(makeResult({ responseText: "APPROVED" })),
        )
        // 2nd resume: unresolved summary (items found)
        .mockReturnValueOnce(
          makeStream(
            makeResult({
              responseText:
                "**[Reviewer Unresolved Round 1]**\n- Error handling in module X\n- Missing test for edge case Y",
            }),
          ),
        )
        // 3rd resume: unresolved verdict (COMPLETED — items were posted)
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
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

  test("retries with clarification when unresolved verdict is ambiguous", async () => {
    let bResumeCall = 0;
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "Review posted.",
          }),
        ),
      ),
      resume: vi.fn().mockImplementation(() => {
        bResumeCall++;
        if (bResumeCall === 1) {
          // 1st resume: review verdict
          return makeStream(makeResult({ responseText: "APPROVED" }));
        }
        if (bResumeCall === 2) {
          // 2nd resume: unresolved summary (work step)
          return makeStream(
            makeResult({
              responseText:
                "**[Reviewer Unresolved Round 1]**\n- Item X needs attention",
            }),
          );
        }
        if (bResumeCall === 3) {
          // 3rd resume: unresolved verdict — ambiguous response
          return makeStream(makeResult({ responseText: "APPROVED" }));
        }
        if (bResumeCall === 4) {
          // 4th resume: clarification retry — correct verdict
          return makeStream(makeResult({ responseText: "COMPLETED" }));
        }
        return makeStream(makeResult({ responseText: "COMPLETED" }));
      }),
    };

    const agentA: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "PR finalized." })),
        ),
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "PR_FINALIZED" })),
        ),
    };

    const opts = makeOpts({ agentB, agentA });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("Unresolved items:");
    expect(result.message).toContain("Item X needs attention");
    // Agent B should be resumed 4 times: review verdict, unresolved
    // summary, ambiguous verdict, clarification retry.
    expect(agentB.resume).toHaveBeenCalledTimes(4);
  });

  test("treats out-of-scope unresolved verdict as ambiguous and retries", async () => {
    let bResumeCall = 0;
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "Review posted.",
          }),
        ),
      ),
      resume: vi.fn().mockImplementation(() => {
        bResumeCall++;
        if (bResumeCall === 1) {
          return makeStream(makeResult({ responseText: "APPROVED" }));
        }
        if (bResumeCall === 2) {
          // unresolved summary work step
          return makeStream(
            makeResult({ responseText: "Nothing unresolved." }),
          );
        }
        if (bResumeCall === 3) {
          // unresolved verdict — out-of-scope keyword
          return makeStream(makeResult({ responseText: "NONE and COMPLETED" }));
        }
        // clarification retry — correct verdict
        return makeStream(makeResult({ responseText: "NONE" }));
      }),
    };

    const agentA: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "PR finalized." })),
        ),
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "PR_FINALIZED" })),
        ),
    };

    const opts = makeOpts({ agentB, agentA });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(result.message).not.toContain("Unresolved items:");
    // Clarification retry was needed: 4 resume calls.
    expect(agentB.resume).toHaveBeenCalledTimes(4);
  });

  test("returns error when unresolved verdict clarification retry fails", async () => {
    let bResumeCall = 0;
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "Review posted.",
          }),
        ),
      ),
      resume: vi.fn().mockImplementation(() => {
        bResumeCall++;
        if (bResumeCall === 1) {
          return makeStream(makeResult({ responseText: "APPROVED" }));
        }
        if (bResumeCall === 2) {
          return makeStream(
            makeResult({ responseText: "Nothing unresolved." }),
          );
        }
        if (bResumeCall === 3) {
          // ambiguous verdict
          return makeStream(makeResult({ responseText: "I think NONE" }));
        }
        // clarification retry — error
        return makeStream(
          makeResult({
            status: "error",
            errorType: "execution_error",
            responseText: "agent crashed",
          }),
        );
      }),
    };

    const opts = makeOpts({ agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("unresolved summary clarification");
  });

  test("includes summary text when unresolved verdict stays ambiguous after retry", async () => {
    let bResumeCall = 0;
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "Review posted.",
          }),
        ),
      ),
      resume: vi.fn().mockImplementation(() => {
        bResumeCall++;
        if (bResumeCall === 1) {
          return makeStream(makeResult({ responseText: "APPROVED" }));
        }
        if (bResumeCall === 2) {
          // unresolved summary work step
          return makeStream(
            makeResult({
              responseText:
                "**[Reviewer Unresolved Round 1]**\n- Item still open",
            }),
          );
        }
        if (bResumeCall === 3) {
          // unresolved verdict — ambiguous
          return makeStream(
            makeResult({ responseText: "I'm not sure, maybe COMPLETED" }),
          );
        }
        // clarification retry — still ambiguous
        return makeStream(
          makeResult({ responseText: "Well, it could be either one" }),
        );
      }),
    };

    const opts = makeOpts({ agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    // Conservatively includes the summary text and proceeds to PR
    // finalization (default agentA mock handles it).
    expect(result.outcome).toBe("completed");
    expect(agentB.resume).toHaveBeenCalledTimes(4);
  });

  test("uses verdict session ID for unresolved summary when verdict advances session", async () => {
    let bResumeCall = 0;
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b-initial",
            responseText: "Review posted.",
          }),
        ),
      ),
      resume: vi.fn().mockImplementation(() => {
        bResumeCall++;
        if (bResumeCall === 1) {
          // 1st resume: review verdict — returns a NEW session ID
          return makeStream(
            makeResult({
              sessionId: "sess-b-after-verdict",
              responseText: "APPROVED",
            }),
          );
        }
        if (bResumeCall === 2) {
          // 2nd resume: unresolved summary work step
          return makeStream(
            makeResult({ responseText: "Nothing unresolved." }),
          );
        }
        // 3rd resume: unresolved verdict
        return makeStream(makeResult({ responseText: "NONE" }));
      }),
    };

    const agentA: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "PR finalized." })),
        ),
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "PR_FINALIZED" })),
        ),
    };

    const opts = makeOpts({ agentB, agentA });
    const stage = createReviewStageHandler(opts);
    await stage.handler(BASE_CTX);

    // The unresolved summary (2nd resume) must use the session ID
    // returned by the verdict step, not the initial invoke session.
    const calls = (agentB.resume as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[1][0]).toBe("sess-b-after-verdict");
  });

  test("invokes B fresh for verdict when B returns no sessionId", async () => {
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

    // Handler recovers by invoking B fresh for the verdict instead
    // of crashing.  B is invoked at least twice: review + fresh
    // verdict (plus further invocations for unresolved summary).
    expect(
      (agentB.invoke as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
    expect(result.outcome).toBe("completed");
  });

  test("uses resume prompt with repo context for unresolved summary when no B session", async () => {
    // When PR comments show an APPROVED verdict for the current round,
    // the handler skips straight to unresolved_summary with no B session.
    // It should invoke B fresh with the resume prompt that includes
    // repo context and instructions to read the review from the PR.
    const agentB: AgentAdapter = {
      invoke: vi
        .fn()
        // 1st invoke: unresolved summary work step (fresh, no session)
        .mockReturnValueOnce(
          makeStream(
            makeResult({
              sessionId: "sess-b-fresh",
              responseText: "No unresolved items.",
            }),
          ),
        )
        // 2nd invoke: unresolved summary verdict
        .mockReturnValue(makeStream(makeResult({ responseText: "NONE" }))),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "NONE" }))),
    };

    const opts = makeOpts({
      agentB,
      getPrNumber: () => 99,
      fetchPrComments: () => [
        // APPROVED verdict already posted — handler enters at
        // unresolved_summary with no B session.
        { body: "**[Reviewer Round 1]** Review.", user: { login: "bot" } },
        {
          body: "[Review Verdict Round 1: APPROVED]",
          user: { login: "bot" },
        },
      ],
    });
    const stage = createReviewStageHandler(opts);
    await stage.handler(BASE_CTX);

    // B.invoke should have been called (not resume) since there's
    // no session, and the prompt should contain repo context.
    const invokeCall = (agentB.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const prompt: string = invokeCall[0];
    expect(prompt).toContain("Owner: org");
    expect(prompt).toContain("Repo: repo");
    expect(prompt).toContain("[Reviewer Round 1]");
  });

  // -- PR finalization on approval ---------------------------------------------

  test("invokes Agent A for PR finalization after approval", async () => {
    const opts = makeOpts();
    const stage = createReviewStageHandler(opts);
    await stage.handler(BASE_CTX);

    expect(opts.agentA.invoke).toHaveBeenCalledWith(
      expect.stringContaining("Not addressed"),
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  test("returns error when PR finalization agent call fails", async () => {
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

    const opts = makeOpts({ agentA });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("PR finalization");
  });

  test("proceeds as completed when finalization verdict is ambiguous but PR body has issue reference", async () => {
    const agentA: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-a",
            responseText: "I could not update the PR body.",
          }),
        ),
      ),
      // Verdict follow-up also lacks PR_FINALIZED, and clarification retry too.
      resume: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-a2",
            responseText: "I still could not finalize.",
          }),
        ),
      ),
    };

    const getPrBody = vi.fn().mockReturnValue("Closes #42");
    const opts = makeOpts({ agentA, getPrBody });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    // Closes #N with no "## Not addressed" — consistent, safe to proceed.
    expect(result.outcome).toBe("completed");
    expect(getPrBody).toHaveBeenCalledWith("org", "repo", "issue-42");
  });

  test("returns blocked when finalization verdict is ambiguous and PR body lacks issue reference", async () => {
    const agentA: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-a",
            responseText: "I could not update the PR body.",
          }),
        ),
      ),
      resume: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-a2",
            responseText: "I still could not finalize.",
          }),
        ),
      ),
    };

    const getPrBody = vi.fn().mockReturnValue("Some PR body without ref");
    const opts = makeOpts({ agentA, getPrBody });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("blocked");
    expect(result.message).toContain("#42");
  });

  test("returns blocked when finalization verdict replies APPROVED and PR body lacks issue reference", async () => {
    const agentA: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-a",
            responseText: "Done.",
          }),
        ),
      ),
      // Verdict follow-up says APPROVED (wrong keyword), clarification retry too.
      resume: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-a2",
            responseText: "APPROVED",
          }),
        ),
      ),
    };

    const getPrBody = vi.fn().mockReturnValue("No issue ref here");
    const opts = makeOpts({ agentA, getPrBody });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("blocked");
  });

  test("proceeds as completed when finalization verdict replies APPROVED but PR body has Part of ref", async () => {
    const agentA: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-a",
            responseText: "Done.",
          }),
        ),
      ),
      resume: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-a2",
            responseText: "APPROVED",
          }),
        ),
      ),
    };

    const getPrBody = vi
      .fn()
      .mockReturnValue("Part of #42\n\n## Not addressed\n- item");
    const opts = makeOpts({ agentA, getPrBody });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
  });

  test("blocks when Part of ref is present but ## Not addressed section is missing", async () => {
    const agentA: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-a",
            responseText: "Done.",
          }),
        ),
      ),
      resume: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-a2",
            responseText: "APPROVED",
          }),
        ),
      ),
    };

    const getPrBody = vi.fn().mockReturnValue("Part of #42");
    const opts = makeOpts({ agentA, getPrBody });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("blocked");
  });

  test("blocks when Closes ref is present alongside contradictory ## Not addressed section", async () => {
    const agentA: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-a",
            responseText: "Done.",
          }),
        ),
      ),
      resume: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-a2",
            responseText: "APPROVED",
          }),
        ),
      ),
    };

    const getPrBody = vi
      .fn()
      .mockReturnValue("Closes #42\n\n## Not addressed\n- item");
    const opts = makeOpts({ agentA, getPrBody });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("blocked");
  });

  test("blocks when both Closes and Part of refs are present without ## Not addressed", async () => {
    const agentA: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-a",
            responseText: "Done.",
          }),
        ),
      ),
      resume: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-a2",
            responseText: "APPROVED",
          }),
        ),
      ),
    };

    const getPrBody = vi.fn().mockReturnValue("Closes #42\nPart of #42");
    const opts = makeOpts({ agentA, getPrBody });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("blocked");
  });

  test("blocks when both Closes and Part of refs are present with ## Not addressed", async () => {
    const agentA: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-a",
            responseText: "Done.",
          }),
        ),
      ),
      resume: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-a2",
            responseText: "APPROVED",
          }),
        ),
      ),
    };

    const getPrBody = vi
      .fn()
      .mockReturnValue("Closes #42\nPart of #42\n\n## Not addressed\n- item");
    const opts = makeOpts({ agentA, getPrBody });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("blocked");
  });

  test("reports Agent A session ID after PR finalization", async () => {
    const sessionCalls: [string, string][] = [];
    const agentA: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-a-fin",
            responseText: "I verified the PR body.",
          }),
        ),
      ),
      // Verdict follow-up: PR_FINALIZED
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "PR_FINALIZED" })),
        ),
    };

    const opts = makeOpts({ agentA });
    const stage = createReviewStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      onSessionId: (agent, sid) => sessionCalls.push([agent, sid]),
    };
    await stage.handler(ctx);

    expect(sessionCalls).toContainEqual(["a", "sess-a-fin"]);
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

  test("does not invoke Agent A when review verdict is ambiguous", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "I looked at the code.",
          }),
        ),
      ),
      // 1st resume: ambiguous verdict, 2nd: still ambiguous after clarification
      resume: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b2",
            responseText: "I think it is fine.",
          }),
        ),
      ),
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
      // 1st resume: review verdict
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
    };

    const agentA: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-a", responseText: "Fixed." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };

    const getCiStatus = vi.fn().mockReturnValue(makeCiStatus("pass"));
    const getHeadSha = vi.fn().mockReturnValue("deadbeef");
    const opts = makeOpts({ agentA, agentB, getCiStatus, getHeadSha });
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
      // 1st resume: review verdict
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
    };

    const agentA: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-a", responseText: "Fixed." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };

    const getCiStatus = vi.fn().mockReturnValue(makeCiStatus("pending"));
    let elapsed = 0;
    const startTime = Date.now();
    const delay = vi.fn().mockImplementation(async () => {
      elapsed += 500;
    });
    vi.spyOn(Date, "now").mockImplementation(() => startTime + elapsed);

    const opts = makeOpts({
      agentA,
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
            responseText: "Needs changes.",
          }),
        ),
      ),
      resume: vi
        .fn()
        // 1st resume: review verdict (NOT_APPROVED)
        .mockReturnValueOnce(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        )
        // 2nd resume: unresolved summary (items found)
        .mockReturnValueOnce(
          makeStream(
            makeResult({
              responseText:
                "**[Reviewer Unresolved Round 1]**\n- Missing validation in handler",
            }),
          ),
        )
        // 3rd resume: unresolved verdict (COMPLETED)
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };

    const agentA: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-a", responseText: "Fixed." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };

    const opts = makeOpts({ agentA, agentB });
    const stage = createReviewStageHandler(opts);
    const ctx = { ...BASE_CTX, lastAutoIteration: true };
    const result = await stage.handler(ctx);

    expect(result.outcome).toBe("not_approved");
    expect(result.message).toContain("Unresolved items:");
    expect(result.message).toContain("Missing validation in handler");
    // 2nd resume call should be the unresolved summary prompt.
    const calls = (agentB.resume as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[1][1]).toContain("unresolved");
  });

  test("skips unresolved summary on NOT_APPROVED when lastAutoIteration is false", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b",
            responseText: "Needs changes.",
          }),
        ),
      ),
      // 1st resume: review verdict (NOT_APPROVED)
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
    };

    const agentA: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-a", responseText: "Fixed." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };

    const opts = makeOpts({ agentA, agentB });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("not_approved");
    expect(result.message).not.toContain("Unresolved items:");
    // Agent B resume is called once for the verdict, but not for unresolved summary.
    expect(agentB.resume).toHaveBeenCalledTimes(1);
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
      resume: vi
        .fn()
        // 1st resume: review verdict (NOT_APPROVED)
        .mockReturnValueOnce(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        )
        // 2nd resume: unresolved summary (error)
        .mockReturnValue(
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

    const agentA: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-a", responseText: "Fixed." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };

    const opts = makeOpts({ agentA, agentB });
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
        // 1st resume: review verdict (NOT_APPROVED)
        .mockReturnValueOnce(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        )
        // 2nd resume: unresolved summary (some text)
        .mockReturnValueOnce(
          makeStream(makeResult({ responseText: "Nothing unresolved." })),
        )
        // 3rd resume: unresolved verdict (NONE)
        .mockReturnValue(makeStream(makeResult({ responseText: "NONE" }))),
    };

    const agentA: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-a", responseText: "Fixed." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };

    const opts = makeOpts({ agentA, agentB });
    const stage = createReviewStageHandler(opts);
    const ctx = { ...BASE_CTX, lastAutoIteration: true };
    const result = await stage.handler(ctx);

    expect(result.outcome).toBe("not_approved");
    expect(result.message).not.toContain("Unresolved items:");
  });

  test("invokes B fresh for verdict when B returns no sessionId on lastAutoIteration", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: undefined,
            responseText: "NOT_APPROVED",
          }),
        ),
      ),
      resume: vi.fn(),
    };

    const opts = makeOpts({ agentB });
    const stage = createReviewStageHandler(opts);
    const ctx = { ...BASE_CTX, lastAutoIteration: true };
    const result = await stage.handler(ctx);

    // Handler recovers by invoking B fresh instead of crashing.
    expect(agentB.invoke).toHaveBeenCalledTimes(2);
    // Result depends on downstream mocks, but should not throw.
    expect(result).toBeDefined();
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
      // 1st resume: review verdict
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
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

// ---------------------------------------------------------------------------
// onSessionId callback
// ---------------------------------------------------------------------------
describe("onSessionId", () => {
  test("reports agent B session ID after review", async () => {
    const sessionCalls: [string, string][] = [];
    const agentB: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-b-1", responseText: "Looks good." }),
          ),
        ),
      resume: vi
        .fn()
        // 1st resume: review verdict (APPROVED)
        .mockReturnValueOnce(
          makeStream(makeResult({ responseText: "APPROVED" })),
        )
        // 2nd resume: unresolved summary
        .mockReturnValueOnce(
          makeStream(makeResult({ responseText: "Nothing." })),
        )
        // 3rd resume: unresolved verdict (NONE)
        .mockReturnValue(makeStream(makeResult({ responseText: "NONE" }))),
    };
    const agentA: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-a-fin",
            responseText: "I verified the PR body.",
          }),
        ),
      ),
      // Verdict follow-up: PR_FINALIZED
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "PR_FINALIZED" })),
        ),
    };
    const opts = makeOpts({ agentA, agentB });
    const stage = createReviewStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      onSessionId: (agent, sid) => sessionCalls.push([agent, sid]),
    };
    await stage.handler(ctx);
    expect(sessionCalls).toContainEqual(["b", "sess-b-1"]);
  });

  test("reports agent A session ID after fix", async () => {
    const sessionCalls: [string, string][] = [];
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-b-1",
            responseText: "NOT_APPROVED",
          }),
        ),
      ),
      // 1st resume: review verdict
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
    };
    const agentA: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-a-1", responseText: "Fixed." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };
    const ciPass = makeCiStatus("pass", [makeCiRun()]);
    const opts = makeOpts({
      agentA,
      agentB,
      getCiStatus: vi.fn().mockReturnValue(ciPass),
      collectFailureLogs: vi.fn(),
      getHeadSha: vi.fn().mockReturnValue("abc123"),
      delay: vi.fn(),
    });
    const stage = createReviewStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      onSessionId: (agent, sid) => sessionCalls.push([agent, sid]),
    };
    await stage.handler(ctx);
    expect(sessionCalls).toContainEqual(["b", "sess-b-1"]);
    expect(sessionCalls).toContainEqual(["a", "sess-a-1"]);
  });
});

// ---- verdict posting ---------------------------------------------------------

describe("verdict posting", () => {
  test("posts APPROVED verdict as PR comment", async () => {
    const postPrComment = vi.fn();
    const opts = makeOpts({
      getPrNumber: () => 99,
      postPrComment,
      fetchPrComments: () => [
        { body: "**[Reviewer Round 1]** LGTM.", user: { login: "bot" } },
      ],
    });
    const stage = createReviewStageHandler(opts);
    await stage.handler(BASE_CTX);

    expect(postPrComment).toHaveBeenCalledWith(
      "org",
      "repo",
      99,
      "[Review Verdict Round 1: APPROVED]",
    );
  });

  test("posts NOT_APPROVED verdict as PR comment", async () => {
    const postPrComment = vi.fn();
    const agentB: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-b", responseText: "Needs work." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
    };
    const agentA: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-a", responseText: "Fixed." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };
    const opts = makeOpts({
      agentA,
      agentB,
      getPrNumber: () => 99,
      postPrComment,
      fetchPrComments: () => [
        { body: "**[Reviewer Round 1]** Review.", user: { login: "bot" } },
      ],
    });
    const stage = createReviewStageHandler(opts);
    await stage.handler(BASE_CTX);

    expect(postPrComment).toHaveBeenCalledWith(
      "org",
      "repo",
      99,
      "[Review Verdict Round 1: NOT_APPROVED]",
    );
  });

  test("skips verdict posting when getPrNumber returns undefined", async () => {
    const postPrComment = vi.fn();
    const opts = makeOpts({
      getPrNumber: () => undefined,
      postPrComment,
    });
    const stage = createReviewStageHandler(opts);
    await stage.handler(BASE_CTX);

    expect(postPrComment).not.toHaveBeenCalled();
  });

  test("propagates error when verdict posting throws", async () => {
    const postPrComment = vi.fn().mockImplementation(() => {
      throw new Error("network error");
    });
    const opts = makeOpts({
      getPrNumber: () => 99,
      postPrComment,
      fetchPrComments: () => [
        { body: "**[Reviewer Round 1]** Review.", user: { login: "bot" } },
      ],
    });
    const stage = createReviewStageHandler(opts);

    // Verdict posting is required — failure must propagate so the
    // pipeline can retry or surface the error.
    await expect(stage.handler(BASE_CTX)).rejects.toThrow("network error");
  });
});

// ---- comment validation ------------------------------------------------------

describe("comment validation", () => {
  test("returns error when expected author comment is missing for round > 1", async () => {
    const opts = makeOpts({
      getPrNumber: () => 99,
      fetchPrComments: () => [
        // Only reviewer round 1 — no author round 1 comment.
        { body: "**[Reviewer Round 1]** Review.", user: { login: "bot" } },
      ],
    });
    const stage = createReviewStageHandler(opts);
    const ctx: StageContext = { ...BASE_CTX, iteration: 1 }; // round 2
    const result = await stage.handler(ctx);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("[Author Round 1]");
  });

  test("refetches comments after review step so reviewer comment is validated", async () => {
    // After posting the review, the handler refetches PR comments
    // so the reviewer comment validation sees the newly posted
    // comment instead of skipping verification.
    const agentB: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-b", responseText: "Needs work." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
    };
    const agentA: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-a", responseText: "Fixed." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValueOnce(
          makeStream(makeResult({ responseText: "COMPLETED" })),
        ),
    };
    const fetchPrComments = vi
      .fn()
      // First call: no comments yet (sub-step derivation).
      .mockReturnValueOnce([])
      // Second call (refetch after review): reviewer comment now exists.
      .mockReturnValueOnce([
        {
          body: "**[Reviewer Round 1]** Needs work.",
          user: { login: "bot" },
        },
      ]);
    const opts = makeOpts({
      agentA,
      agentB,
      getPrNumber: () => 99,
      fetchPrComments,
      getCiStatus: () => ({
        verdict: "pass" as const,
        runs: [makeCiRun()],
        findings: [],
      }),
    });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("not_approved");
    // The handler called fetchPrComments twice: once for derivation,
    // once as a refetch after posting the review.
    expect(fetchPrComments).toHaveBeenCalledTimes(2);
  });

  test("returns error when refetch after review does not find reviewer comment", async () => {
    // If the reviewer comment was never actually posted (e.g., agent
    // error on the PR side), the refetch should catch the gap.
    const agentB: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-b", responseText: "Needs work." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
    };
    const fetchPrComments = vi.fn().mockReturnValue([]);
    const postPrComment = vi.fn();
    const opts = makeOpts({
      agentB,
      getPrNumber: () => 99,
      fetchPrComments,
      postPrComment,
    });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("[Reviewer Round 1]");
    expect(postPrComment).not.toHaveBeenCalled();
  });

  test("returns error on APPROVED path when reviewer comment is missing", async () => {
    // Even when the verdict is APPROVED, the handler must verify
    // that the reviewer comment actually made it onto the PR.
    const agentB: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-b", responseText: "LGTM." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "APPROVED" }))),
    };
    const fetchPrComments = vi.fn().mockReturnValue([]);
    const postPrComment = vi.fn();
    const opts = makeOpts({
      agentB,
      getPrNumber: () => 99,
      fetchPrComments,
      postPrComment,
    });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("[Reviewer Round 1]");
    expect(postPrComment).not.toHaveBeenCalled();
  });

  test("skips comment validation when getPrNumber returns undefined", async () => {
    const fetchPrComments = vi.fn();
    const agentB: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-b", responseText: "Needs work." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
    };
    const agentA: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-a", responseText: "Fixed." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };
    const opts = makeOpts({
      agentA,
      agentB,
      getPrNumber: () => undefined,
      fetchPrComments,
    });
    const stage = createReviewStageHandler(opts);
    await stage.handler(BASE_CTX);

    // fetchPrComments should not be called when PR number is undefined.
    expect(fetchPrComments).not.toHaveBeenCalled();
  });

  test("proceeds when expected author comment exists for round > 1", async () => {
    const agentB: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-b", responseText: "Still issues." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValueOnce(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        )
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
    };
    const agentA: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-a", responseText: "Fixed again." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };
    const opts = makeOpts({
      agentA,
      agentB,
      getPrNumber: () => 99,
      fetchPrComments: () => [
        { body: "**[Reviewer Round 1]** Review.", user: { login: "bot" } },
        { body: "**[Author Round 1]** Fixes.", user: { login: "bot" } },
        { body: "**[Reviewer Round 2]** More issues.", user: { login: "bot" } },
      ],
    });
    const stage = createReviewStageHandler(opts);
    const ctx: StageContext = { ...BASE_CTX, iteration: 1 }; // round 2
    const result = await stage.handler(ctx);

    // Should proceed (not return error about missing comment).
    expect(result.outcome).not.toBe("error");
  });

  test("resume at verdict returns error before invoking Agent B when reviewer comment is missing for current round", async () => {
    // Regression: if deriveReviewSubStep determines we're at the
    // verdict sub-step (maxReviewerRound >= round) but the specific
    // round's reviewer comment is absent (e.g., round 2 exists but
    // round 1 does not), the handler must NOT invoke Agent B with
    // buildResumeVerdictPrompt referencing the missing comment.
    const agentB: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi.fn(),
    };
    const opts = makeOpts({
      agentB,
      getPrNumber: () => 99,
      fetchPrComments: () => [
        // Round 2 reviewer comment exists but round 1 is missing.
        // parsePrReviewState returns maxReviewerRound=2, so
        // deriveReviewSubStep(prState, 1) yields subStep="verdict"
        // (hasReview is true since 2 >= 1, but no verdict exists).
        // However, hasComment(reviewerRoundPattern(1)) is false.
        { body: "**[Reviewer Round 2]** Review.", user: { login: "bot" } },
      ],
    });
    const stage = createReviewStageHandler(opts);
    // No saved session — handler takes the fresh-invoke branch for
    // the verdict prompt, which is where the guard must fire.
    const ctx: StageContext = { ...BASE_CTX, savedAgentBSessionId: undefined };
    const result = await stage.handler(ctx);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("[Reviewer Round 1]");
    // Agent B must not have been called at all.
    expect(agentB.invoke).not.toHaveBeenCalled();
    expect(agentB.resume).not.toHaveBeenCalled();
  });
});

// ---- onReviewPosted callback --------------------------------------------------

describe("onReviewPosted", () => {
  test("fires with correct round when review step posts a comment", async () => {
    const onReviewPosted = vi.fn();
    const fetchPrComments = vi
      .fn()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([
        {
          body: "**[Reviewer Round 1]** Looks good.",
          user: { login: "bot" },
        },
      ]);
    const opts = makeOpts({
      getPrNumber: () => 99,
      fetchPrComments,
      onReviewPosted,
    });
    const stage = createReviewStageHandler(opts);
    await stage.handler(BASE_CTX);

    expect(onReviewPosted).toHaveBeenCalledWith(1);
  });

  test("does not fire when resuming at verdict (no new review posted)", async () => {
    const onReviewPosted = vi.fn();
    const opts = makeOpts({
      getPrNumber: () => 99,
      fetchPrComments: () => [
        {
          body: "**[Reviewer Round 1]** Needs work.",
          user: { login: "bot" },
        },
      ],
      onReviewPosted,
    });
    const stage = createReviewStageHandler(opts);
    await stage.handler(BASE_CTX);

    expect(onReviewPosted).not.toHaveBeenCalled();
  });

  test("does not fire when refetch still cannot find the reviewer comment", async () => {
    const onReviewPosted = vi.fn();
    // Both initial fetch and refetch return no reviewer comment.
    const fetchPrComments = vi.fn().mockReturnValue([]);
    const opts = makeOpts({
      getPrNumber: () => 99,
      fetchPrComments,
      onReviewPosted,
    });
    const stage = createReviewStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(onReviewPosted).not.toHaveBeenCalled();
    expect(result.outcome).toBe("error");
  });
});

// ---- saved Agent B session reuse on resume ------------------------------------

describe("saved Agent B session reuse on resume", () => {
  test("resume at verdict reuses saved Agent B session", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi
        .fn()
        // 1st resume: review verdict
        .mockReturnValueOnce(
          makeStream(makeResult({ responseText: "APPROVED" })),
        )
        // 2nd resume: unresolved summary
        .mockReturnValueOnce(
          makeStream(
            makeResult({
              sessionId: "sess-b-verdict",
              responseText: "No unresolved items.",
            }),
          ),
        )
        // 3rd resume: unresolved verdict
        .mockReturnValue(makeStream(makeResult({ responseText: "NONE" }))),
    };

    const opts = makeOpts({
      agentB,
      getPrNumber: () => 99,
      fetchPrComments: () => [
        // Reviewer comment present — handler derives currentStep=verdict.
        { body: "**[Reviewer Round 1]** Review.", user: { login: "bot" } },
      ],
    });
    const stage = createReviewStageHandler(opts);
    await stage.handler({
      ...BASE_CTX,
      savedAgentBSessionId: "saved-b-sess",
    });

    // The verdict step should resume the saved B session, not invoke fresh.
    expect(agentB.invoke).not.toHaveBeenCalled();
    const firstResumeCall = (agentB.resume as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(firstResumeCall[0]).toBe("saved-b-sess");
  });

  test("resume at unresolved_summary reuses saved Agent B session", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi
        .fn()
        // 1st resume: unresolved summary
        .mockReturnValueOnce(
          makeStream(
            makeResult({
              sessionId: "sess-b-unresolved",
              responseText: "No unresolved items.",
            }),
          ),
        )
        // 2nd resume: unresolved verdict
        .mockReturnValue(makeStream(makeResult({ responseText: "NONE" }))),
    };

    const opts = makeOpts({
      agentB,
      getPrNumber: () => 99,
      fetchPrComments: () => [
        { body: "**[Reviewer Round 1]** Review.", user: { login: "bot" } },
        {
          body: "[Review Verdict Round 1: APPROVED]",
          user: { login: "bot" },
        },
      ],
    });
    const stage = createReviewStageHandler(opts);
    await stage.handler({
      ...BASE_CTX,
      savedAgentBSessionId: "saved-b-sess",
    });

    // The unresolved summary step should resume the saved B session.
    expect(agentB.invoke).not.toHaveBeenCalled();
    const firstResumeCall = (agentB.resume as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(firstResumeCall[0]).toBe("saved-b-sess");
  });
});
