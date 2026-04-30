import { describe, expect, test, vi } from "vitest";
import type { AgentAdapter, AgentResult, AgentStream } from "./agent.js";
import type { CiRun, CiStatus, CiVerdict } from "./ci.js";
import type { StageContext } from "./pipeline.js";
import { PipelineEventEmitter } from "./pipeline-events.js";
import {
  buildSquashCompletionCheckPrompt,
  buildSquashPrompt,
  buildSquashSuggestionComment,
  createSquashStageHandler,
  parseSquashEnvelope,
  parseSquashSuggestionBlock,
  postOrUpdateSquashSuggestion,
  SQUASH_SUGGESTION_END_MARKER,
  SQUASH_SUGGESTION_START_MARKER,
  type SquashStageOptions,
} from "./stage-squash.js";

// ---- helpers ---------------------------------------------------------------

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    sessionId: "sess-1",
    responseText: "SQUASHED_MULTI",
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
  overrides: Partial<SquashStageOptions> = {},
): SquashStageOptions {
  const agent: AgentAdapter = {
    invoke: vi
      .fn()
      .mockReturnValue(
        makeStream(
          makeResult({ sessionId: "sess-squash", responseText: "Squashed." }),
        ),
      ),
    resume: vi
      .fn()
      .mockReturnValue(
        makeStream(makeResult({ responseText: "SQUASHED_MULTI" })),
      ),
  };

  return {
    agent,
    issueTitle: "Fix the widget",
    issueBody: "The widget is broken.",
    defaultBranch: "main",
    getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
    collectFailureLogs: vi.fn().mockReturnValue(""),
    getHeadSha: vi.fn().mockReturnValue("abc123"),
    delay: vi.fn().mockResolvedValue(undefined),
    pollIntervalMs: 100,
    pollTimeoutMs: 1000,
    emptyRunsGracePeriodMs: 0,
    countBranchCommits: vi.fn().mockReturnValue(2),
    findSuggestionCommentBody: vi.fn().mockReturnValue(undefined),
    findPrNumber: vi.fn().mockReturnValue(42),
    queryPrState: vi.fn().mockReturnValue("OPEN"),
    chooseSquashApplyMode: vi.fn().mockResolvedValue("agent"),
    ...overrides,
  };
}

// ---- buildSquashPrompt -------------------------------------------------------

describe("buildSquashPrompt", () => {
  test("includes repo and issue context", () => {
    const prompt = buildSquashPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("Owner: org");
    expect(prompt).toContain("Repo: repo");
    expect(prompt).toContain("Branch: issue-42");
    expect(prompt).toContain("Issue #42: Fix the widget");
    expect(prompt).toContain("The widget is broken.");
  });

  test("includes both squash paths and the SUGGESTED_SINGLE envelope contract", () => {
    const prompt = buildSquashPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("If a single commit is appropriate");
    expect(prompt).toContain("If multiple commits are appropriate");
    expect(prompt).toContain("Force-push the branch");
    expect(prompt).toContain("<<<TITLE>>>");
    expect(prompt).toContain("<<</TITLE>>>");
    expect(prompt).toContain("<<<BODY>>>");
    expect(prompt).toContain("<<</BODY>>>");
  });

  // Negative assertions: the SUGGESTED_SINGLE branch no longer asks the
  // agent to author the marker-delimited PR comment itself.  Marker
  // placement, fence-length math, and idempotent PATCH/POST bookkeeping
  // are now deterministic concerns owned by `buildSquashSuggestionComment`
  // / `postOrUpdateSquashSuggestion`.  Use `not.toContain` so this test
  // does not break on copy edits to the surrounding prose.
  test("SUGGESTED_SINGLE prompt no longer references marker / gh comment / fence math", () => {
    const prompt = buildSquashPrompt(BASE_CTX, makeOpts());
    expect(prompt).not.toContain("squash-suggestion:start");
    expect(prompt).not.toContain("squash-suggestion:end");
    expect(prompt).not.toContain("gh pr comment");
    expect(prompt).not.toContain("gh api repos");
    expect(prompt).not.toContain("--method PATCH");
    expect(prompt).not.toContain("fence_len");
    expect(prompt).not.toContain("longest run of backticks");
  });

  test("includes PR description sync instructions", () => {
    const prompt = buildSquashPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("gh pr view");
    expect(prompt).toContain("gh pr edit");
  });

  test("includes user instruction when present", () => {
    const ctx = { ...BASE_CTX, userInstruction: "Keep merge commits" };
    const prompt = buildSquashPrompt(ctx, makeOpts());
    expect(prompt).toContain("Additional feedback");
    expect(prompt).toContain("Keep merge commits");
  });

  test("omits feedback section when no instruction", () => {
    const prompt = buildSquashPrompt(BASE_CTX, makeOpts());
    expect(prompt).not.toContain("Additional feedback");
  });

  test("includes base SHA in squash range when baseSha is set", () => {
    const ctx = { ...BASE_CTX, baseSha: "abc1234def5678" };
    const prompt = buildSquashPrompt(ctx, makeOpts());
    expect(prompt).toContain("abc1234def5678");
    expect(prompt).toContain("git reset --soft abc1234def5678");
  });

  test("falls back to generic squash when baseSha is absent", () => {
    const prompt = buildSquashPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("Review all commits on this branch");
    expect(prompt).not.toContain("git reset --soft");
  });

  test("includes the three-way decision instruction", () => {
    const prompt = buildSquashPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("single logical change");
    expect(prompt).toContain("genuinely independent");
  });
});

// ---- buildSquashCompletionCheckPrompt ----------------------------------------

describe("buildSquashCompletionCheckPrompt", () => {
  test("mentions all three verdict keywords", () => {
    const prompt = buildSquashCompletionCheckPrompt();
    expect(prompt).toContain("SQUASHED_MULTI");
    expect(prompt).toContain("SUGGESTED_SINGLE");
    expect(prompt).toContain("BLOCKED");
  });
});

// ---- createSquashStageHandler ------------------------------------------------

describe("createSquashStageHandler", () => {
  test("returns stage definition with number 8 and correct name", () => {
    const stage = createSquashStageHandler(makeOpts());
    expect(stage.number).toBe(8);
    expect(stage.name).toBe("Squash commits");
    expect(stage.requiresArtifact).toBe(true);
  });

  // -- single commit skip ----------------------------------------------------

  test("skips squash when branch has a single commit", async () => {
    const countBranchCommits = vi.fn().mockReturnValue(1);
    const opts = makeOpts({ countBranchCommits });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("Single commit");
    expect(countBranchCommits).toHaveBeenCalledWith("/tmp/wt", "main");
    expect(opts.agent.invoke).not.toHaveBeenCalled();
    expect(opts.agent.resume).not.toHaveBeenCalled();
  });

  test("proceeds with squash when branch has multiple commits", async () => {
    const countBranchCommits = vi.fn().mockReturnValue(3);
    const opts = makeOpts({ countBranchCommits });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(opts.agent.invoke).toHaveBeenCalled();
  });

  // -- happy path: squash + CI pass ------------------------------------------

  test("returns completed when squash succeeds and CI passes", async () => {
    const opts = makeOpts();
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("CI passed");
    expect(opts.agent.invoke).toHaveBeenCalled();
    expect(opts.agent.resume).toHaveBeenCalled();
  });

  test("invokes agent then resumes for completion check", async () => {
    const opts = makeOpts();
    const stage = createSquashStageHandler(opts);
    await stage.handler(BASE_CTX);

    expect(opts.agent.invoke).toHaveBeenCalledWith(expect.any(String), {
      cwd: "/tmp/wt",
    });
    expect(opts.agent.resume).toHaveBeenCalledWith(
      "sess-squash",
      expect.any(String),
      { cwd: "/tmp/wt" },
    );
  });

  // -- blocked ---------------------------------------------------------------

  test("returns blocked when agent says BLOCKED", async () => {
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-squash",
            responseText: "Tried to squash.",
          }),
        ),
      ),
      resume: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            responseText: "BLOCKED",
          }),
        ),
      ),
    };
    const opts = makeOpts({ agent });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("blocked");
    expect(result.message).toContain("Tried to squash");
    expect(result.message).toContain("BLOCKED");
  });

  // -- CI fails after squash -------------------------------------------------

  test("returns error when CI fails after all fix attempts", async () => {
    const getCiStatus = vi
      .fn()
      .mockReturnValue(
        makeCiStatus("fail", [
          makeCiRun({ conclusion: "failure", databaseId: 200 }),
        ]),
      );
    const collectFailureLogs = vi.fn().mockReturnValue("test failed");

    // Agent fix invocations (for CI fix loop)
    const invokeResults = [
      // First call: squash prompt
      makeStream(
        makeResult({
          sessionId: "sess-squash",
          responseText: "Squashed.",
        }),
      ),
      // Subsequent calls: CI fix attempts
      makeStream(makeResult({ responseText: "Fixed CI." })),
      makeStream(makeResult({ responseText: "Fixed CI again." })),
      makeStream(makeResult({ responseText: "Fixed CI third time." })),
    ];
    let invokeCall = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => invokeResults[invokeCall++]),
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "SQUASHED_MULTI" })),
        ),
    };

    const opts = makeOpts({
      agent,
      getCiStatus,
      collectFailureLogs,
      maxFixAttempts: 3,
    });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("still failing");
  });

  test("returns completed when CI fails then passes after fix", async () => {
    const getCiStatus = vi
      .fn()
      .mockReturnValueOnce(
        makeCiStatus("fail", [
          makeCiRun({ conclusion: "failure", databaseId: 200 }),
        ]),
      )
      .mockReturnValueOnce(makeCiStatus("pass"));
    const collectFailureLogs = vi.fn().mockReturnValue("test failed");

    const invokeResults = [
      makeStream(
        makeResult({
          sessionId: "sess-squash",
          responseText: "Squashed.",
        }),
      ),
      makeStream(makeResult({ responseText: "Fixed CI." })),
    ];
    let invokeCall = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => invokeResults[invokeCall++]),
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "SQUASHED_MULTI" })),
        ),
    };

    const opts = makeOpts({ agent, getCiStatus, collectFailureLogs });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
  });

  // -- error handling --------------------------------------------------------

  test("returns error when squash agent call fails", async () => {
    const agent: AgentAdapter = {
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
    const opts = makeOpts({ agent });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("maximum turn limit");
    expect(result.message).toContain("squash");
  });

  test("returns error when completion check fails", async () => {
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-squash",
            responseText: "Squashed.",
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
    const opts = makeOpts({ agent });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("crash");
  });

  test("throws when squash returns no sessionId", async () => {
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ sessionId: undefined }))),
      resume: vi.fn(),
    };
    const opts = makeOpts({ agent });
    const stage = createSquashStageHandler(opts);
    await expect(stage.handler(BASE_CTX)).rejects.toThrow("no session ID");
  });

  // -- ambiguous then clarified -----------------------------------------------

  test("retries with clarification on ambiguous completion response", async () => {
    let resumeCall = 0;
    const resumeResults = [
      // First resume: ambiguous
      makeStream(
        makeResult({
          sessionId: "sess-2",
          responseText: "I squashed the commits.",
        }),
      ),
      // Second resume: clarified
      makeStream(makeResult({ responseText: "SQUASHED_MULTI" })),
    ];

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-squash",
            responseText: "Squashed.",
          }),
        ),
      ),
      resume: vi.fn().mockImplementation(() => resumeResults[resumeCall++]),
    };

    const opts = makeOpts({ agent });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(agent.resume).toHaveBeenCalledTimes(2);
  });

  test("ambiguous check without sessionId retries via fallback session", async () => {
    const ambiguousCheck = makeResult({
      sessionId: undefined,
      responseText: "I squashed the commits.",
    });

    let resumeCall = 0;
    const resumeResults = [
      // 1st resume: ambiguous completion check (no sessionId)
      makeStream(ambiguousCheck),
      // 2nd resume: clarification retry via fallback session
      makeStream(makeResult({ responseText: "SQUASHED_MULTI" })),
    ];

    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ sessionId: "sess-squash" }))),
      resume: vi.fn().mockImplementation(() => resumeResults[resumeCall++]),
    };

    const opts = makeOpts({ agent });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    // Clarification retry succeeds via fallback to "sess-squash".
    expect(result.outcome).toBe("completed");
    expect(agent.resume).toHaveBeenCalledTimes(2);
    // The retry used the invoke session as fallback.
    expect((agent.resume as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe(
      "sess-squash",
    );
  });

  // -- CI pending then pass ---------------------------------------------------

  test("polls CI when pending then completes on pass", async () => {
    const getCiStatus = vi
      .fn()
      .mockReturnValueOnce(makeCiStatus("pending"))
      .mockReturnValueOnce(makeCiStatus("pass"));
    const delay = vi.fn().mockResolvedValue(undefined);

    const opts = makeOpts({ getCiStatus, delay });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(getCiStatus).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledTimes(1);
  });

  // -- CI pending timeout -----------------------------------------------------

  test("returns error when CI pending exceeds timeout after squash", async () => {
    const getCiStatus = vi.fn().mockReturnValue(makeCiStatus("pending"));
    let elapsed = 0;
    const startTime = Date.now();
    const delay = vi.fn().mockImplementation(async () => {
      elapsed += 500;
    });
    vi.spyOn(Date, "now").mockImplementation(() => startTime + elapsed);

    const opts = makeOpts({
      getCiStatus,
      delay,
      pollIntervalMs: 100,
      pollTimeoutMs: 1000,
    });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("still pending");

    vi.restoreAllMocks();
  });

  // -- multiple failed CI runs with logs --------------------------------------

  test("collects logs from multiple failed CI runs", async () => {
    const runs = [
      makeCiRun({ databaseId: 200, name: "lint", conclusion: "failure" }),
      makeCiRun({ databaseId: 201, name: "test", conclusion: "failure" }),
      makeCiRun({ databaseId: 202, name: "build", conclusion: "success" }),
    ];
    const getCiStatus = vi
      .fn()
      .mockReturnValueOnce(makeCiStatus("fail", runs))
      .mockReturnValueOnce(makeCiStatus("pass"));
    const collectFailureLogs = vi
      .fn()
      .mockReturnValueOnce("lint: unused var")
      .mockReturnValueOnce("test: assertion failed");

    const invokeResults = [
      makeStream(
        makeResult({
          sessionId: "sess-squash",
          responseText: "Squashed.",
        }),
      ),
      makeStream(makeResult({ responseText: "Fixed CI." })),
    ];
    let invokeCall = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => invokeResults[invokeCall++]),
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "SQUASHED_MULTI" })),
        ),
    };

    const opts = makeOpts({ agent, getCiStatus, collectFailureLogs });
    const stage = createSquashStageHandler(opts);
    await stage.handler(BASE_CTX);

    expect(collectFailureLogs).toHaveBeenCalledTimes(2);
    expect(collectFailureLogs).toHaveBeenCalledWith(
      "org",
      "repo",
      expect.objectContaining({ databaseId: 200 }),
    );
    expect(collectFailureLogs).toHaveBeenCalledWith(
      "org",
      "repo",
      expect.objectContaining({ databaseId: 201 }),
    );
  });

  // -- non-terminal non-blocked completion outcome ----------------------------

  test("proceeds as completed when clarification also ambiguous but commit count decreased", async () => {
    let resumeCall = 0;
    const resumeResults = [
      makeStream(
        makeResult({
          sessionId: "sess-2",
          responseText: "I squashed the commits.",
        }),
      ),
      makeStream(
        makeResult({ responseText: "I finished the squash process." }),
      ),
    ];

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-squash",
            responseText: "Squashed.",
          }),
        ),
      ),
      resume: vi.fn().mockImplementation(() => resumeResults[resumeCall++]),
    };

    const countBranchCommits = vi
      .fn()
      .mockReturnValueOnce(2) // initial check: > 1, proceed
      .mockReturnValueOnce(1); // post-condition: decreased, completed
    const opts = makeOpts({ agent, countBranchCommits });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(countBranchCommits).toHaveBeenCalledTimes(2);
  });

  test("returns blocked when clarification also ambiguous and commit count unchanged", async () => {
    let resumeCall = 0;
    const resumeResults = [
      makeStream(
        makeResult({
          sessionId: "sess-2",
          responseText: "I squashed the commits.",
        }),
      ),
      makeStream(
        makeResult({ responseText: "I finished the squash process." }),
      ),
    ];

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-squash",
            responseText: "Squashed.",
          }),
        ),
      ),
      resume: vi.fn().mockImplementation(() => resumeResults[resumeCall++]),
    };

    const countBranchCommits = vi.fn().mockReturnValue(2); // unchanged
    const opts = makeOpts({ agent, countBranchCommits });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("blocked");
    expect(result.message).toContain("Squashed.");
  });

  // -- getHeadSha forwarding ----------------------------------------------------

  test("forwards getHeadSha to pollCiAndFix and uses SHA in getCiStatus", async () => {
    const getCiStatus = vi.fn().mockReturnValue(makeCiStatus("pass"));
    const getHeadSha = vi.fn().mockReturnValue("deadbeef");
    const opts = makeOpts({ getCiStatus, getHeadSha });
    const stage = createSquashStageHandler(opts);
    await stage.handler(BASE_CTX);

    expect(getHeadSha).toHaveBeenCalledWith("/tmp/wt");
    expect(getCiStatus).toHaveBeenCalledWith(
      "org",
      "repo",
      "issue-42",
      "deadbeef",
    );
  });

  // -- agent error during CI fix attempt --------------------------------------

  test("returns error when agent fails during CI fix attempt", async () => {
    const getCiStatus = vi
      .fn()
      .mockReturnValue(
        makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]),
      );
    const collectFailureLogs = vi.fn().mockReturnValue("err");

    const invokeResults = [
      makeStream(
        makeResult({
          sessionId: "sess-squash",
          responseText: "Squashed.",
        }),
      ),
      makeStream(
        makeResult({
          status: "error",
          errorType: "execution_error",
          stderrText: "agent crash",
          responseText: "",
        }),
      ),
    ];
    let invokeCall = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => invokeResults[invokeCall++]),
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "SQUASHED_MULTI" })),
        ),
    };

    const opts = makeOpts({ agent, getCiStatus, collectFailureLogs });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("agent crash");
  });

  // -- SUGGESTED_SINGLE: user picks "agent" ----------------------------------

  test("SUGGESTED_SINGLE + user picks agent → follow-up + CI poll runs", async () => {
    const prBodyWithMarker = `Hello\n${SQUASH_SUGGESTION_START_MARKER}\n## Suggested squash commit\n\n**Title**\n\n\`\`\`text\nMy title\n\`\`\`\n\n**Body**\n\n\`\`\`text\nLine\n\`\`\`\n${SQUASH_SUGGESTION_END_MARKER}`;
    let resumeCall = 0;
    const resumeResults = [
      makeStream(makeResult({ responseText: "SUGGESTED_SINGLE" })),
      makeStream(
        makeResult({
          sessionId: "sess-followup",
          responseText: "Squashed and pushed.",
        }),
      ),
    ];
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-squash", responseText: "Plan." }),
          ),
        ),
      resume: vi.fn().mockImplementation(() => resumeResults[resumeCall++]),
    };
    const chooseSquashApplyMode = vi.fn().mockResolvedValue("agent");
    const findSuggestionCommentBody = vi.fn().mockReturnValue(prBodyWithMarker);
    const onSquashSubStep = vi.fn();
    const opts = makeOpts({
      agent,
      chooseSquashApplyMode,
      findSuggestionCommentBody,
      onSquashSubStep,
    });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("CI passed");
    expect(chooseSquashApplyMode).toHaveBeenCalledTimes(1);
    expect(agent.resume).toHaveBeenCalledTimes(2); // verdict + follow-up
    expect(opts.getCiStatus).toHaveBeenCalled();
    const states = onSquashSubStep.mock.calls.map((c) => c[0]);
    expect(states).toContain("planning");
    expect(states).toContain("awaiting_user_choice");
    expect(states).toContain("squashing");
    expect(states).toContain("ci_poll");
  });

  // -- SUGGESTED_SINGLE: user picks "github" ---------------------------------

  test("SUGGESTED_SINGLE + user picks github → no CI poll, applied_via_github", async () => {
    const prBodyWithMarker = `${SQUASH_SUGGESTION_START_MARKER}\n**Title**\n\n\`\`\`text\nT\n\`\`\`\n\n**Body**\n\n\`\`\`text\nB\n\`\`\`\n${SQUASH_SUGGESTION_END_MARKER}`;
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-squash", responseText: "Plan." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "SUGGESTED_SINGLE" })),
        ),
    };
    const chooseSquashApplyMode = vi.fn().mockResolvedValue("github");
    const findSuggestionCommentBody = vi.fn().mockReturnValue(prBodyWithMarker);
    const onSquashSubStep = vi.fn();
    const getCiStatus = vi.fn();
    const opts = makeOpts({
      agent,
      chooseSquashApplyMode,
      findSuggestionCommentBody,
      onSquashSubStep,
      getCiStatus,
    });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("Squash and merge");
    expect(getCiStatus).not.toHaveBeenCalled();
    const states = onSquashSubStep.mock.calls.map((c) => c[0]);
    expect(states[states.length - 1]).toBe("applied_via_github");
  });

  // -- SUGGESTED_SINGLE missing marker → BLOCKED -----------------------------

  test("SUGGESTED_SINGLE with missing marker block → blocked", async () => {
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-squash", responseText: "Plan." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "SUGGESTED_SINGLE" })),
        ),
    };
    const opts = makeOpts({
      agent,
      findSuggestionCommentBody: vi
        .fn()
        .mockReturnValue("body without any marker"),
    });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("blocked");
  });

  // -- PR already merged short-circuit ---------------------------------------

  test("SUGGESTED_SINGLE + PR already merged before user prompt → alreadyMerged, no chooseSquashApplyMode call", async () => {
    const prBodyWithMarker = `${SQUASH_SUGGESTION_START_MARKER}\n**Title**\n\n\`\`\`text\nT\n\`\`\`\n\n**Body**\n\n\`\`\`text\nB\n\`\`\`\n${SQUASH_SUGGESTION_END_MARKER}`;
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-squash", responseText: "Plan." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "SUGGESTED_SINGLE" })),
        ),
    };
    const chooseSquashApplyMode = vi.fn().mockResolvedValue("agent");
    const findSuggestionCommentBody = vi.fn().mockReturnValue(prBodyWithMarker);
    const queryPrState = vi.fn().mockReturnValue("MERGED");
    const onSquashSubStep = vi.fn();
    const getCiStatus = vi.fn();
    const opts = makeOpts({
      agent,
      chooseSquashApplyMode,
      findSuggestionCommentBody,
      queryPrState,
      onSquashSubStep,
      getCiStatus,
    });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("already merged");
    expect(chooseSquashApplyMode).not.toHaveBeenCalled();
    expect(getCiStatus).not.toHaveBeenCalled();
    expect(queryPrState).toHaveBeenCalledWith("org", "repo", "issue-42");
    // Sub-step must be cleared so a resume does not re-enter the dead choice.
    expect(onSquashSubStep).toHaveBeenLastCalledWith(undefined);
  });

  // Regression for issue #274 reviewer round 1: on the immediate
  // SUGGESTED_SINGLE branch, the PR-merged guard must also run
  // BEFORE the suggestion-comment lookup.  `findPrNumber` uses
  // `gh pr list` (open PRs only), so a concurrent merge would make
  // the comment lookup return `undefined` and the stage would flip
  // to `BLOCKED` instead of short-circuiting to `alreadyMerged`.
  test("SUGGESTED_SINGLE + concurrent merge hides the PR from findPrNumber → alreadyMerged, not blocked", async () => {
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-squash", responseText: "Plan." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "SUGGESTED_SINGLE" })),
        ),
    };
    // `findPrNumber` returns `undefined` once the PR is merged
    // because `gh pr list` filters to open PRs by default.
    const findPrNumber = vi.fn().mockReturnValue(undefined);
    const findSuggestionCommentBody = vi.fn();
    const chooseSquashApplyMode = vi.fn();
    const queryPrState = vi.fn().mockReturnValue("MERGED");
    const onSquashSubStep = vi.fn();
    const opts = makeOpts({
      agent,
      findPrNumber,
      findSuggestionCommentBody,
      chooseSquashApplyMode,
      queryPrState,
      onSquashSubStep,
    });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("already merged");
    // Guard runs before the comment lookup.
    expect(findPrNumber).not.toHaveBeenCalled();
    expect(findSuggestionCommentBody).not.toHaveBeenCalled();
    expect(chooseSquashApplyMode).not.toHaveBeenCalled();
    expect(queryPrState).toHaveBeenCalledWith("org", "repo", "issue-42");
    expect(onSquashSubStep).toHaveBeenLastCalledWith(undefined);
  });

  test("user picks agent, but PR merges between query and follow-up → alreadyMerged, no sendFollowUp call", async () => {
    const prBodyWithMarker = `${SQUASH_SUGGESTION_START_MARKER}\n**Title**\n\n\`\`\`text\nT\n\`\`\`\n\n**Body**\n\n\`\`\`text\nB\n\`\`\`\n${SQUASH_SUGGESTION_END_MARKER}`;
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-squash", responseText: "Plan." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "SUGGESTED_SINGLE" })),
        ),
    };
    // First guardIfPrMerged call (before askUserAndApply) returns OPEN so
    // the user prompt runs; the second guard call (inside askUserAndApply
    // before the "agent" branch) returns MERGED.
    const queryPrState = vi
      .fn()
      .mockReturnValueOnce("OPEN")
      .mockReturnValueOnce("MERGED");
    const chooseSquashApplyMode = vi.fn().mockResolvedValue("agent");
    const findSuggestionCommentBody = vi.fn().mockReturnValue(prBodyWithMarker);
    const onSquashSubStep = vi.fn();
    const getCiStatus = vi.fn();
    const opts = makeOpts({
      agent,
      chooseSquashApplyMode,
      findSuggestionCommentBody,
      queryPrState,
      onSquashSubStep,
      getCiStatus,
    });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("already merged");
    expect(chooseSquashApplyMode).toHaveBeenCalledTimes(1);
    // Only the verdict resume happened — no follow-up squash resume.
    expect(agent.resume).toHaveBeenCalledTimes(1);
    expect(getCiStatus).not.toHaveBeenCalled();
    const states = onSquashSubStep.mock.calls.map((c) => c[0]);
    // Never transitioned to "squashing".
    expect(states).not.toContain("squashing");
    expect(states[states.length - 1]).toBe(undefined);
  });

  // -- Post-clarification fallback ordering ----------------------------------

  describe("post-clarification fallback ordering", () => {
    function makeAmbiguousAgent(): AgentAdapter {
      let resumeCall = 0;
      const resumeResults = [
        makeStream(
          makeResult({
            sessionId: "sess-2",
            responseText: "I think it's done.",
          }),
        ),
        makeStream(makeResult({ responseText: "Still vague." })),
      ];
      return {
        invoke: vi.fn().mockReturnValue(
          makeStream(
            makeResult({
              sessionId: "sess-squash",
              responseText: "Worked on it.",
            }),
          ),
        ),
        resume: vi.fn().mockImplementation(() => resumeResults[resumeCall++]),
      };
    }

    test("count decreased AND marker present → SQUASHED_MULTI (count wins)", async () => {
      const prBody = `${SQUASH_SUGGESTION_START_MARKER}\n**Title**\n\n\`\`\`text\nstale\n\`\`\`\n\n**Body**\n\n\`\`\`text\nstale body\n\`\`\`\n${SQUASH_SUGGESTION_END_MARKER}`;
      const opts = makeOpts({
        agent: makeAmbiguousAgent(),
        countBranchCommits: vi
          .fn()
          .mockReturnValueOnce(3)
          .mockReturnValueOnce(1),
        findSuggestionCommentBody: vi.fn().mockReturnValue(prBody),
      });
      const stage = createSquashStageHandler(opts);
      const result = await stage.handler(BASE_CTX);
      expect(result.outcome).toBe("completed");
      expect(result.message).toContain("CI passed");
    });

    test("count unchanged AND marker present → SUGGESTED_SINGLE", async () => {
      const prBody = `${SQUASH_SUGGESTION_START_MARKER}\n**Title**\n\n\`\`\`text\nsuggested\n\`\`\`\n\n**Body**\n\n\`\`\`text\nsuggested body\n\`\`\`\n${SQUASH_SUGGESTION_END_MARKER}`;
      const chooseSquashApplyMode = vi.fn().mockResolvedValue("github");
      const opts = makeOpts({
        agent: makeAmbiguousAgent(),
        countBranchCommits: vi.fn().mockReturnValue(2),
        findSuggestionCommentBody: vi.fn().mockReturnValue(prBody),
        chooseSquashApplyMode,
      });
      const stage = createSquashStageHandler(opts);
      const result = await stage.handler(BASE_CTX);
      expect(result.outcome).toBe("completed");
      expect(chooseSquashApplyMode).toHaveBeenCalled();
    });

    test("neither → BLOCKED", async () => {
      const opts = makeOpts({
        agent: makeAmbiguousAgent(),
        countBranchCommits: vi.fn().mockReturnValue(2),
        findSuggestionCommentBody: vi.fn().mockReturnValue(undefined),
        findPrNumber: vi.fn().mockReturnValue(42),
      });
      const stage = createSquashStageHandler(opts);
      const result = await stage.handler(BASE_CTX);
      expect(result.outcome).toBe("blocked");
    });

    // Regression for issue #274 reviewer round 2: when the agent
    // never returns a parseable verdict and the deterministic
    // fallback runs, the PR-merged guard must run BEFORE the
    // suggestion-comment lookup.  `findPrNumber` uses `gh pr list`
    // (open PRs only), so a concurrent merge between the
    // clarification turn and this fallback would make the lookup
    // return `undefined` and the verdict would flip to BLOCKED
    // instead of taking the existing merged short-circuit.
    test("ambiguous verdict + PR merged before fallback → alreadyMerged, not BLOCKED", async () => {
      const queryPrState = vi.fn().mockReturnValue("MERGED");
      const findPrNumber = vi.fn().mockReturnValue(undefined);
      const findSuggestionCommentBody = vi.fn();
      const onSquashSubStep = vi.fn();
      const opts = makeOpts({
        agent: makeAmbiguousAgent(),
        // Commit count unchanged → would otherwise fall into the
        // comment-lookup branch.
        countBranchCommits: vi.fn().mockReturnValue(2),
        queryPrState,
        findPrNumber,
        findSuggestionCommentBody,
        onSquashSubStep,
      });
      const stage = createSquashStageHandler(opts);
      const result = await stage.handler(BASE_CTX);

      expect(result.outcome).toBe("completed");
      expect(result.message).toContain("already merged");
      // The lifecycle guard runs before the comment lookup.
      expect(queryPrState).toHaveBeenCalledWith("org", "repo", "issue-42");
      expect(findPrNumber).not.toHaveBeenCalled();
      expect(findSuggestionCommentBody).not.toHaveBeenCalled();
      expect(onSquashSubStep).toHaveBeenLastCalledWith(undefined);
    });
  });

  // -- resume on each substate -----------------------------------------------

  describe("resume on saved substate", () => {
    test("applied_via_github → returns completed without invoking agent", async () => {
      const opts = makeOpts({ savedSquashSubStep: "applied_via_github" });
      const stage = createSquashStageHandler(opts);
      const result = await stage.handler(BASE_CTX);
      expect(result.outcome).toBe("completed");
      expect(opts.agent.invoke).not.toHaveBeenCalled();
      expect(opts.agent.resume).not.toHaveBeenCalled();
    });

    test("ci_poll → skips planning, runs CI poll only", async () => {
      const opts = makeOpts({ savedSquashSubStep: "ci_poll" });
      const stage = createSquashStageHandler(opts);
      const result = await stage.handler(BASE_CTX);
      expect(result.outcome).toBe("completed");
      expect(opts.agent.invoke).not.toHaveBeenCalled();
      expect(opts.getCiStatus).toHaveBeenCalled();
    });

    test("awaiting_user_choice with marker present → re-presents user choice", async () => {
      const prBody = `${SQUASH_SUGGESTION_START_MARKER}\n**Title**\n\n\`\`\`text\nT\n\`\`\`\n\n**Body**\n\n\`\`\`text\nB\n\`\`\`\n${SQUASH_SUGGESTION_END_MARKER}`;
      const chooseSquashApplyMode = vi.fn().mockResolvedValue("github");
      const opts = makeOpts({
        savedSquashSubStep: "awaiting_user_choice",
        findSuggestionCommentBody: vi.fn().mockReturnValue(prBody),
        chooseSquashApplyMode,
      });
      const stage = createSquashStageHandler(opts);
      const result = await stage.handler(BASE_CTX);
      expect(result.outcome).toBe("completed");
      expect(chooseSquashApplyMode).toHaveBeenCalled();
      expect(opts.agent.invoke).not.toHaveBeenCalled();
    });

    // Regression: a user who picks "agent" when no session is
    // available must be blocked, not silently routed to the github
    // completion message (which would misrepresent what happened).
    test("awaiting_user_choice + user picks agent + no session → blocked", async () => {
      const prBody = `${SQUASH_SUGGESTION_START_MARKER}\n**Title**\n\n\`\`\`text\nT\n\`\`\`\n\n**Body**\n\n\`\`\`text\nB\n\`\`\`\n${SQUASH_SUGGESTION_END_MARKER}`;
      const chooseSquashApplyMode = vi.fn().mockResolvedValue("agent");
      const onSquashSubStep = vi.fn();
      const getCiStatus = vi.fn();
      const opts = makeOpts({
        savedSquashSubStep: "awaiting_user_choice",
        findSuggestionCommentBody: vi.fn().mockReturnValue(prBody),
        chooseSquashApplyMode,
        onSquashSubStep,
        getCiStatus,
      });
      const stage = createSquashStageHandler(opts);
      // No savedAgentASessionId on the ctx.
      const result = await stage.handler(BASE_CTX);

      expect(result.outcome).toBe("blocked");
      expect(result.message).toContain("session");
      expect(chooseSquashApplyMode).toHaveBeenCalledTimes(1);
      expect(opts.agent.invoke).not.toHaveBeenCalled();
      expect(opts.agent.resume).not.toHaveBeenCalled();
      expect(getCiStatus).not.toHaveBeenCalled();
      const states = onSquashSubStep.mock.calls.map((c) => c[0]);
      expect(states).not.toContain("applied_via_github");
      expect(states).not.toContain("ci_poll");
    });

    test("awaiting_user_choice with marker missing → falls back to fresh planning run", async () => {
      const opts = makeOpts({
        savedSquashSubStep: "awaiting_user_choice",
        findSuggestionCommentBody: vi.fn().mockReturnValue(undefined),
        findPrNumber: vi.fn().mockReturnValue(42),
      });
      const stage = createSquashStageHandler(opts);
      await stage.handler(BASE_CTX);
      expect(opts.agent.invoke).toHaveBeenCalled();
    });

    // Regression for issue #274 reviewer round 1: resuming from
    // `awaiting_user_choice` must check the PR lifecycle BEFORE
    // reading the suggestion comment.  `findPrNumber` uses
    // `gh pr list` (open PRs only), so a PR merged between the
    // interruption and the resume would make the comment lookup
    // return `undefined` and fall through to a fresh planning run
    // — completely bypassing the `squash.alreadyMerged` short-circuit.
    test("awaiting_user_choice with PR already merged → alreadyMerged, no fresh planning, no user choice", async () => {
      const queryPrState = vi.fn().mockReturnValue("MERGED");
      const chooseSquashApplyMode = vi.fn();
      const findPrNumber = vi.fn().mockReturnValue(undefined);
      const findSuggestionCommentBody = vi.fn();
      const onSquashSubStep = vi.fn();
      const opts = makeOpts({
        savedSquashSubStep: "awaiting_user_choice",
        queryPrState,
        chooseSquashApplyMode,
        findPrNumber,
        findSuggestionCommentBody,
        onSquashSubStep,
      });
      const stage = createSquashStageHandler(opts);
      const result = await stage.handler(BASE_CTX);

      expect(result.outcome).toBe("completed");
      expect(result.message).toContain("already merged");
      expect(queryPrState).toHaveBeenCalledWith("org", "repo", "issue-42");
      // The lifecycle guard must run BEFORE the comment lookup, so
      // neither `findPrNumber` nor `findSuggestionCommentBody`
      // should be consulted once the PR is known to be merged.
      expect(findPrNumber).not.toHaveBeenCalled();
      expect(findSuggestionCommentBody).not.toHaveBeenCalled();
      expect(chooseSquashApplyMode).not.toHaveBeenCalled();
      expect(opts.agent.invoke).not.toHaveBeenCalled();
      expect(onSquashSubStep).toHaveBeenLastCalledWith(undefined);
    });

    // Regression for issue #252 review feedback: resuming from
    // "squashing" must not re-send the full planning prompt.
    test("squashing with commit count collapsed to 1 → jumps straight to CI poll", async () => {
      const countBranchCommits = vi.fn().mockReturnValue(1);
      const onSquashSubStep = vi.fn();
      const opts = makeOpts({
        savedSquashSubStep: "squashing",
        countBranchCommits,
        onSquashSubStep,
      });
      const stage = createSquashStageHandler(opts);
      const result = await stage.handler({
        ...BASE_CTX,
        savedAgentASessionId: "sess-squash",
      });
      expect(result.outcome).toBe("completed");
      expect(result.message).toContain("CI passed");
      // No agent turns at all — the squash already happened.
      expect(opts.agent.invoke).not.toHaveBeenCalled();
      expect(opts.agent.resume).not.toHaveBeenCalled();
      expect(opts.getCiStatus).toHaveBeenCalled();
      const states = onSquashSubStep.mock.calls.map((c) => c[0]);
      expect(states).not.toContain("planning");
      expect(states).toContain("ci_poll");
    });

    test("squashing with count still > 1 and session available → re-sends follow-up only", async () => {
      const resume = vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-followup",
            responseText: "Squashed and pushed.",
          }),
        ),
      );
      const agent: AgentAdapter = {
        invoke: vi.fn(),
        resume,
      };
      const promptSink = vi.fn();
      const onSquashSubStep = vi.fn();
      const opts = makeOpts({
        agent,
        savedSquashSubStep: "squashing",
        countBranchCommits: vi.fn().mockReturnValue(3),
        onSquashSubStep,
      });
      const stage = createSquashStageHandler(opts);
      const result = await stage.handler({
        ...BASE_CTX,
        savedAgentASessionId: "sess-squash",
        promptSinks: { a: promptSink },
      });
      expect(result.outcome).toBe("completed");
      expect(agent.invoke).not.toHaveBeenCalled();
      expect(resume).toHaveBeenCalledTimes(1);
      const [resumedSession, resumedPrompt] = resume.mock.calls[0];
      expect(resumedSession).toBe("sess-squash");
      expect(resumedPrompt).toContain("user chose to have you perform");
      // The planning prompt must NOT be sent again.
      const sentPrompts = promptSink.mock.calls.map((c) => c[0]);
      expect(
        sentPrompts.some((p: string) => p.includes("Decide whether the work")),
      ).toBe(false);
      expect(opts.getCiStatus).toHaveBeenCalled();
      const states = onSquashSubStep.mock.calls.map((c) => c[0]);
      expect(states).not.toContain("planning");
      expect(states).toContain("ci_poll");
    });

    test("squashing with count still > 1 but no saved session → falls back to fresh planning run", async () => {
      const opts = makeOpts({
        savedSquashSubStep: "squashing",
        countBranchCommits: vi.fn().mockReturnValue(3),
      });
      const stage = createSquashStageHandler(opts);
      await stage.handler(BASE_CTX);
      // Last-resort fallback: planning prompt is sent via invoke.
      expect(opts.agent.invoke).toHaveBeenCalled();
    });

    // Regression for issue #260 reviewer round 1: resuming from
    // "squashing" must re-check PR lifecycle, otherwise a PR merged
    // between the interruption and the resume sends a wasted
    // follow-up or burns a CI poll cycle on a closed branch.
    test("squashing with PR already merged on resume → alreadyMerged, no follow-up, no CI poll", async () => {
      const resume = vi.fn();
      const invoke = vi.fn();
      const agent: AgentAdapter = { invoke, resume };
      const queryPrState = vi.fn().mockReturnValue("MERGED");
      const onSquashSubStep = vi.fn();
      const getCiStatus = vi.fn();
      const opts = makeOpts({
        agent,
        savedSquashSubStep: "squashing",
        countBranchCommits: vi.fn().mockReturnValue(3),
        queryPrState,
        onSquashSubStep,
        getCiStatus,
      });
      const stage = createSquashStageHandler(opts);
      const result = await stage.handler({
        ...BASE_CTX,
        savedAgentASessionId: "sess-squash",
      });

      expect(result.outcome).toBe("completed");
      expect(result.message).toContain("already merged");
      expect(invoke).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect(getCiStatus).not.toHaveBeenCalled();
      expect(queryPrState).toHaveBeenCalledWith("org", "repo", "issue-42");
      // Sub-step cleared so a later resume does not re-enter the dead state.
      expect(onSquashSubStep).toHaveBeenLastCalledWith(undefined);
    });

    // Companion to the test above: the PR-merged guard fires even
    // when the branch has already collapsed to one commit (the
    // "jump straight to CI poll" path), so the wasted CI poll on a
    // closed branch is also avoided.
    test("squashing with collapsed branch but PR already merged → alreadyMerged, no CI poll", async () => {
      const queryPrState = vi.fn().mockReturnValue("MERGED");
      const getCiStatus = vi.fn();
      const onSquashSubStep = vi.fn();
      const opts = makeOpts({
        savedSquashSubStep: "squashing",
        countBranchCommits: vi.fn().mockReturnValue(1),
        queryPrState,
        getCiStatus,
        onSquashSubStep,
      });
      const stage = createSquashStageHandler(opts);
      const result = await stage.handler(BASE_CTX);

      expect(result.outcome).toBe("completed");
      expect(result.message).toContain("already merged");
      expect(getCiStatus).not.toHaveBeenCalled();
      expect(onSquashSubStep).toHaveBeenLastCalledWith(undefined);
    });
  });

  // -- live sub-step/session on retry (issue #252 review round 3) -------------

  describe("live sub-step / session on in-process retry", () => {
    // Regression: after SUGGESTED_SINGLE → agent → ci_poll, a ci_poll
    // error triggers a fresh handler invocation.  The handler must
    // read the live persisted sub-step (via the getter form) rather
    // than the startup snapshot — otherwise the branch has already
    // collapsed to one commit and the single-commit skip path returns
    // a false successful completion instead of resuming CI polling.
    test("ci_poll resume re-enters via live getter after branch collapsed to 1", async () => {
      // Simulate: startup snapshot was undefined; a previous iteration
      // then transitioned to "ci_poll" and persisted it.  The retry
      // must observe that persisted value.
      const liveSubStep = vi.fn(() => "ci_poll" as const);
      // Branch already has one commit — single-commit skip WOULD fire
      // if the live sub-step getter were ignored.
      const countBranchCommits = vi.fn().mockReturnValue(1);
      const getCiStatus = vi.fn().mockReturnValue(makeCiStatus("pass"));
      const opts = makeOpts({
        savedSquashSubStep: liveSubStep,
        countBranchCommits,
        getCiStatus,
      });
      const stage = createSquashStageHandler(opts);
      const result = await stage.handler(BASE_CTX);

      expect(liveSubStep).toHaveBeenCalled();
      expect(result.outcome).toBe("completed");
      expect(result.message).toContain("CI passed");
      expect(result.message).not.toContain("Single commit");
      expect(opts.agent.invoke).not.toHaveBeenCalled();
      expect(getCiStatus).toHaveBeenCalled();
    });

    // Regression: the getter for the persisted agent-A session id
    // allows the handler to re-use the saved conversation on retry
    // even though the pipeline's one-shot `ctx.savedAgentASessionId`
    // was cleared after the first iteration.
    test("resume from squashing reuses session via getSavedAgentSessionId when ctx session is absent", async () => {
      const resume = vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-followup",
            responseText: "Squashed and pushed.",
          }),
        ),
      );
      const agent: AgentAdapter = { invoke: vi.fn(), resume };
      const opts = makeOpts({
        agent,
        savedSquashSubStep: () => "squashing",
        countBranchCommits: vi.fn().mockReturnValue(3),
        getSavedAgentSessionId: () => "sess-persisted",
      });
      const stage = createSquashStageHandler(opts);
      // Mimic an in-process retry: ctx.savedAgentASessionId is
      // undefined because the pipeline already cleared it.
      const result = await stage.handler(BASE_CTX);

      expect(result.outcome).toBe("completed");
      expect(agent.invoke).not.toHaveBeenCalled();
      expect(resume).toHaveBeenCalledTimes(1);
      expect(resume.mock.calls[0][0]).toBe("sess-persisted");
    });
  });

  // -- verdict session id persistence (issue #252 review round 5) -----------
  //
  // `resolveVerdict()` may surface a session id that differs from the
  // planning turn's (adapters can update the id on follow-up turns).
  // Stage 8 must persist the latest verdict session id via
  // `ctx.onSessionId` BEFORE entering `awaiting_user_choice`, so that a
  // resume + user "agent" choice continues the exact conversation that
  // drafted the squash-suggestion comment — not the older planning session.
  describe("verdict session id persistence", () => {
    test("SUGGESTED_SINGLE persists verdict session (distinct from planning) before awaiting choice", async () => {
      const prBody = `${SQUASH_SUGGESTION_START_MARKER}\n**Title**\n\n\`\`\`text\nT\n\`\`\`\n\n**Body**\n\n\`\`\`text\nB\n\`\`\`\n${SQUASH_SUGGESTION_END_MARKER}`;
      const invoke = vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-planning",
            responseText: "Drafted suggestion.",
          }),
        ),
      );
      // Verdict turn surfaces a different session id.
      const resume = vi
        .fn()
        .mockReturnValueOnce(
          makeStream(
            makeResult({
              sessionId: "sess-verdict",
              responseText: "SUGGESTED_SINGLE",
            }),
          ),
        )
        // Later follow-up for the agent squash path.
        .mockReturnValueOnce(
          makeStream(
            makeResult({
              sessionId: "sess-followup",
              responseText: "Squashed and pushed.",
            }),
          ),
        );
      const agent: AgentAdapter = { invoke, resume };

      const sessionCalls: Array<[string, string]> = [];
      const chooseSquashApplyMode = vi.fn().mockResolvedValue("agent");
      const opts = makeOpts({
        agent,
        findSuggestionCommentBody: vi.fn().mockReturnValue(prBody),
        chooseSquashApplyMode,
      });
      const stage = createSquashStageHandler(opts);
      await stage.handler({
        ...BASE_CTX,
        onSessionId: (a, sid) => sessionCalls.push([a, sid]),
      });

      const persisted = sessionCalls.map(([, sid]) => sid);
      // The verdict session id must have been persisted before the
      // user-choice prompt.  It must also precede the follow-up turn,
      // so a resume after that point would pick the correct session.
      const verdictIndex = persisted.indexOf("sess-verdict");
      expect(verdictIndex).toBeGreaterThanOrEqual(0);

      // chooseSquashApplyMode was called exactly once, and for "agent"
      // the follow-up resume was sent on the verdict session id.
      expect(chooseSquashApplyMode).toHaveBeenCalledTimes(1);
      // resume calls: 0 = verdict check, 1 = agent squash follow-up.
      expect(resume.mock.calls[1][0]).toBe("sess-verdict");
    });

    test("resume from awaiting_user_choice + user picks agent resumes the verdict session id via getSavedAgentSessionId", async () => {
      const prBody = `${SQUASH_SUGGESTION_START_MARKER}\n**Title**\n\n\`\`\`text\nT\n\`\`\`\n\n**Body**\n\n\`\`\`text\nB\n\`\`\`\n${SQUASH_SUGGESTION_END_MARKER}`;
      const resume = vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-followup",
            responseText: "Squashed and pushed.",
          }),
        ),
      );
      const agent: AgentAdapter = { invoke: vi.fn(), resume };

      const chooseSquashApplyMode = vi.fn().mockResolvedValue("agent");
      const opts = makeOpts({
        agent,
        savedSquashSubStep: "awaiting_user_choice",
        findSuggestionCommentBody: vi.fn().mockReturnValue(prBody),
        chooseSquashApplyMode,
        // The persisted session id is the VERDICT session, not the
        // planning session — proving the Round 5 fix wires the
        // follow-up to the verdict conversation on resume.
        getSavedAgentSessionId: () => "sess-verdict",
      });
      const stage = createSquashStageHandler(opts);
      // Clear ctx.savedAgentASessionId to force the getter path.
      const result = await stage.handler(BASE_CTX);

      expect(result.outcome).toBe("completed");
      expect(chooseSquashApplyMode).toHaveBeenCalledTimes(1);
      expect(resume).toHaveBeenCalledTimes(1);
      expect(resume.mock.calls[0][0]).toBe("sess-verdict");
      expect(agent.invoke).not.toHaveBeenCalled();
    });
  });

  // -- pipeline:verdict telemetry on fallback chain (issue #252 review round 3)
  // The deterministic fallback chain derives the verdict from commit
  // count and the squash-suggestion PR comment when both agent
  // responses are ambiguous.  That derived keyword must still be
  // surfaced as a pipeline:verdict event so telemetry consumers see
  // every verdict, not just the parsed ones.
  describe("pipeline:verdict emission from deterministic fallback", () => {
    function makeAmbiguousAgent(): AgentAdapter {
      let resumeCall = 0;
      const resumeResults = [
        makeStream(
          makeResult({
            sessionId: "sess-2",
            responseText: "I think it's done.",
          }),
        ),
        makeStream(makeResult({ responseText: "Still vague." })),
      ];
      return {
        invoke: vi.fn().mockReturnValue(
          makeStream(
            makeResult({
              sessionId: "sess-squash",
              responseText: "Worked on it.",
            }),
          ),
        ),
        resume: vi.fn().mockImplementation(() => resumeResults[resumeCall++]),
      };
    }

    test("emits SQUASHED_MULTI when commit count decreased", async () => {
      const events = new PipelineEventEmitter();
      const handler = vi.fn();
      events.on("pipeline:verdict", handler);
      const opts = makeOpts({
        agent: makeAmbiguousAgent(),
        countBranchCommits: vi
          .fn()
          .mockReturnValueOnce(3)
          .mockReturnValueOnce(1),
        findSuggestionCommentBody: vi.fn().mockReturnValue(undefined),
        findPrNumber: vi.fn().mockReturnValue(42),
      });
      const stage = createSquashStageHandler(opts);
      await stage.handler({ ...BASE_CTX, events });

      const keywords = handler.mock.calls.map((c) => c[0].keyword);
      expect(keywords).toContain("SQUASHED_MULTI");
    });

    test("emits SUGGESTED_SINGLE when marker block is present", async () => {
      const prBody = `${SQUASH_SUGGESTION_START_MARKER}\n**Title**\n\n\`\`\`text\ns\n\`\`\`\n\n**Body**\n\n\`\`\`text\ns body\n\`\`\`\n${SQUASH_SUGGESTION_END_MARKER}`;
      const events = new PipelineEventEmitter();
      const handler = vi.fn();
      events.on("pipeline:verdict", handler);
      const opts = makeOpts({
        agent: makeAmbiguousAgent(),
        countBranchCommits: vi.fn().mockReturnValue(2),
        findSuggestionCommentBody: vi.fn().mockReturnValue(prBody),
        chooseSquashApplyMode: vi.fn().mockResolvedValue("github"),
      });
      const stage = createSquashStageHandler(opts);
      await stage.handler({ ...BASE_CTX, events });

      const keywords = handler.mock.calls.map((c) => c[0].keyword);
      expect(keywords).toContain("SUGGESTED_SINGLE");
    });

    test("emits BLOCKED when neither signal is present", async () => {
      const events = new PipelineEventEmitter();
      const handler = vi.fn();
      events.on("pipeline:verdict", handler);
      const opts = makeOpts({
        agent: makeAmbiguousAgent(),
        countBranchCommits: vi.fn().mockReturnValue(2),
        findSuggestionCommentBody: vi.fn().mockReturnValue(undefined),
        findPrNumber: vi.fn().mockReturnValue(42),
      });
      const stage = createSquashStageHandler(opts);
      await stage.handler({ ...BASE_CTX, events });

      const keywords = handler.mock.calls.map((c) => c[0].keyword);
      expect(keywords).toContain("BLOCKED");
    });
  });

  // -- malformed suggestion block (marker present, parser fails) -------------
  //
  // Stage 9 reads the block via `parseSquashSuggestionBlock` to render
  // the inline preview, so Stage 8 must reject any block the parser
  // cannot handle (start marker only, missing end marker, missing
  // `**Title**` label).  Otherwise the SUGGESTED_SINGLE path completes
  // with `applied_via_github` and Stage 9 has nothing to show.
  describe("malformed suggestion block", () => {
    function makeMalformedBodies(): Array<{ name: string; body: string }> {
      return [
        {
          name: "start marker only (no end marker)",
          body: `${SQUASH_SUGGESTION_START_MARKER}\n**Title**\n\n\`\`\`text\nT\n\`\`\`\n\n**Body**\n\n\`\`\`text\nB\n\`\`\``,
        },
        {
          name: "both markers but no Title line",
          body: `${SQUASH_SUGGESTION_START_MARKER}\nNo title here\n${SQUASH_SUGGESTION_END_MARKER}`,
        },
      ];
    }

    test.each(
      makeMalformedBodies(),
    )("verdict SUGGESTED_SINGLE + $name → blocked, no user choice", async ({
      body,
    }) => {
      const agent: AgentAdapter = {
        invoke: vi.fn().mockReturnValue(
          makeStream(
            makeResult({
              sessionId: "sess-squash",
              responseText: "Plan.",
            }),
          ),
        ),
        resume: vi
          .fn()
          .mockReturnValue(
            makeStream(makeResult({ responseText: "SUGGESTED_SINGLE" })),
          ),
      };
      const chooseSquashApplyMode = vi.fn().mockResolvedValue("github");
      const onSquashSubStep = vi.fn();
      const opts = makeOpts({
        agent,
        findSuggestionCommentBody: vi.fn().mockReturnValue(body),
        chooseSquashApplyMode,
        onSquashSubStep,
      });
      const stage = createSquashStageHandler(opts);
      const result = await stage.handler(BASE_CTX);

      expect(result.outcome).toBe("blocked");
      expect(chooseSquashApplyMode).not.toHaveBeenCalled();
      const states = onSquashSubStep.mock.calls.map((c) => c[0]);
      expect(states).not.toContain("applied_via_github");
      expect(states).not.toContain("awaiting_user_choice");
    });

    test.each(
      makeMalformedBodies(),
    )("fallback chain + $name → BLOCKED (not SUGGESTED_SINGLE)", async ({
      body,
    }) => {
      let resumeCall = 0;
      const resumeResults = [
        makeStream(
          makeResult({
            sessionId: "sess-2",
            responseText: "I think it's done.",
          }),
        ),
        makeStream(makeResult({ responseText: "Still vague." })),
      ];
      const agent: AgentAdapter = {
        invoke: vi.fn().mockReturnValue(
          makeStream(
            makeResult({
              sessionId: "sess-squash",
              responseText: "Worked on it.",
            }),
          ),
        ),
        resume: vi.fn().mockImplementation(() => resumeResults[resumeCall++]),
      };
      const events = new PipelineEventEmitter();
      const handler = vi.fn();
      events.on("pipeline:verdict", handler);
      const opts = makeOpts({
        agent,
        countBranchCommits: vi.fn().mockReturnValue(2),
        findSuggestionCommentBody: vi.fn().mockReturnValue(body),
      });
      const stage = createSquashStageHandler(opts);
      const result = await stage.handler({ ...BASE_CTX, events });

      expect(result.outcome).toBe("blocked");
      const keywords = handler.mock.calls.map((c) => c[0].keyword);
      expect(keywords).toContain("BLOCKED");
      expect(keywords).not.toContain("SUGGESTED_SINGLE");
    });

    test.each(
      makeMalformedBodies(),
    )("resume awaiting_user_choice + $name → re-runs planning, no user choice", async ({
      body,
    }) => {
      const chooseSquashApplyMode = vi.fn().mockResolvedValue("github");
      const opts = makeOpts({
        savedSquashSubStep: "awaiting_user_choice",
        findSuggestionCommentBody: vi.fn().mockReturnValue(body),
        chooseSquashApplyMode,
      });
      const stage = createSquashStageHandler(opts);
      await stage.handler(BASE_CTX);

      expect(chooseSquashApplyMode).not.toHaveBeenCalled();
      expect(opts.agent.invoke).toHaveBeenCalled();
    });
  });

  // -- squashApplyPolicy: auto vs ask --------------------------------------

  describe("squashApplyPolicy", () => {
    function makePrCommentBody(): string {
      return `${SQUASH_SUGGESTION_START_MARKER}\n**Title**\n\n\`\`\`text\nT\n\`\`\`\n\n**Body**\n\n\`\`\`text\nB\n\`\`\`\n${SQUASH_SUGGESTION_END_MARKER}`;
    }

    test("policy=auto skips chooseSquashApplyMode and proceeds as agent", async () => {
      const prBody = makePrCommentBody();
      const resumeResults = [
        makeStream(makeResult({ responseText: "SUGGESTED_SINGLE" })),
        makeStream(
          makeResult({
            sessionId: "sess-followup",
            responseText: "Squashed and pushed.",
          }),
        ),
      ];
      let resumeCall = 0;
      const agent: AgentAdapter = {
        invoke: vi
          .fn()
          .mockReturnValue(
            makeStream(
              makeResult({ sessionId: "sess-squash", responseText: "Plan." }),
            ),
          ),
        resume: vi.fn().mockImplementation(() => resumeResults[resumeCall++]),
      };
      const chooseSquashApplyMode = vi.fn();
      const onSquashSubStep = vi.fn();
      const opts = makeOpts({
        agent,
        chooseSquashApplyMode,
        findSuggestionCommentBody: vi.fn().mockReturnValue(prBody),
        onSquashSubStep,
        squashApplyPolicy: "auto",
      });
      const stage = createSquashStageHandler(opts);
      const result = await stage.handler(BASE_CTX);

      expect(result.outcome).toBe("completed");
      expect(result.message).toContain("CI passed");
      // Policy prompt never fired.
      expect(chooseSquashApplyMode).not.toHaveBeenCalled();
      // Followed the "agent" branch: verdict resume + follow-up resume.
      expect(agent.resume).toHaveBeenCalledTimes(2);
      expect(opts.getCiStatus).toHaveBeenCalled();
      const states = onSquashSubStep.mock.calls.map((c) => c[0]);
      expect(states).toContain("squashing");
      expect(states).toContain("ci_poll");
      expect(states).not.toContain("applied_via_github");
    });

    test("policy=ask still calls chooseSquashApplyMode and honors the user choice", async () => {
      const prBody = makePrCommentBody();
      const agent: AgentAdapter = {
        invoke: vi
          .fn()
          .mockReturnValue(
            makeStream(
              makeResult({ sessionId: "sess-squash", responseText: "Plan." }),
            ),
          ),
        resume: vi
          .fn()
          .mockReturnValue(
            makeStream(makeResult({ responseText: "SUGGESTED_SINGLE" })),
          ),
      };
      const chooseSquashApplyMode = vi.fn().mockResolvedValue("github");
      const onSquashSubStep = vi.fn();
      const getCiStatus = vi.fn();
      const opts = makeOpts({
        agent,
        chooseSquashApplyMode,
        findSuggestionCommentBody: vi.fn().mockReturnValue(prBody),
        onSquashSubStep,
        getCiStatus,
        squashApplyPolicy: "ask",
      });
      const stage = createSquashStageHandler(opts);
      const result = await stage.handler(BASE_CTX);

      expect(result.outcome).toBe("completed");
      expect(chooseSquashApplyMode).toHaveBeenCalledTimes(1);
      expect(getCiStatus).not.toHaveBeenCalled();
      const states = onSquashSubStep.mock.calls.map((c) => c[0]);
      expect(states[states.length - 1]).toBe("applied_via_github");
    });

    test("policy=auto applies on resume from awaiting_user_choice as well", async () => {
      const prBody = makePrCommentBody();
      const resume = vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-followup",
            responseText: "Squashed and pushed.",
          }),
        ),
      );
      const agent: AgentAdapter = { invoke: vi.fn(), resume };
      const chooseSquashApplyMode = vi.fn();
      const opts = makeOpts({
        agent,
        savedSquashSubStep: "awaiting_user_choice",
        findSuggestionCommentBody: vi.fn().mockReturnValue(prBody),
        chooseSquashApplyMode,
        getSavedAgentSessionId: () => "sess-verdict",
        squashApplyPolicy: "auto",
      });
      const stage = createSquashStageHandler(opts);
      const result = await stage.handler(BASE_CTX);

      expect(result.outcome).toBe("completed");
      // Auto policy on resume still skips the prompt.
      expect(chooseSquashApplyMode).not.toHaveBeenCalled();
      // Agent follow-up was sent via the saved verdict session.
      expect(resume).toHaveBeenCalledTimes(1);
      expect(resume.mock.calls[0][0]).toBe("sess-verdict");
    });
  });
});

// ---- parseSquashSuggestionBlock --------------------------------------------

describe("parseSquashSuggestionBlock", () => {
  // ---- fenced format (current) ---------------------------------------------

  test("parses title and body from a well-formed fenced block", () => {
    const body = [
      "noise",
      SQUASH_SUGGESTION_START_MARKER,
      "## Suggested squash commit",
      "",
      "**Title**",
      "",
      "```text",
      "Fix widget rendering",
      "```",
      "",
      "**Body**",
      "",
      "```text",
      "First line.",
      "",
      "Closes #42",
      "```",
      SQUASH_SUGGESTION_END_MARKER,
      "more noise",
    ].join("\n");
    expect(parseSquashSuggestionBlock(body)).toEqual({
      title: "Fix widget rendering",
      body: "First line.\n\nCloses #42",
    });
  });

  test("parses a body that contains a nested triple-backtick fenced block (outer fence length 4)", () => {
    const body = [
      SQUASH_SUGGESTION_START_MARKER,
      "",
      "**Title**",
      "",
      "```text",
      "Fix code sample rendering",
      "```",
      "",
      "**Body**",
      "",
      "````text",
      "Repro:",
      "",
      "```js",
      "foo();",
      "```",
      "",
      "Closes #1",
      "````",
      SQUASH_SUGGESTION_END_MARKER,
    ].join("\n");
    expect(parseSquashSuggestionBlock(body)).toEqual({
      title: "Fix code sample rendering",
      body: "Repro:\n\n```js\nfoo();\n```\n\nCloses #1",
    });
  });

  test("parses a body containing a run of five backticks (outer fence length 6)", () => {
    const body = [
      SQUASH_SUGGESTION_START_MARKER,
      "",
      "**Title**",
      "",
      "```text",
      "Handle large fences",
      "```",
      "",
      "**Body**",
      "",
      "``````text",
      "Look at this nesting:",
      "",
      "`````",
      "inner",
      "`````",
      "``````",
      SQUASH_SUGGESTION_END_MARKER,
    ].join("\n");
    expect(parseSquashSuggestionBlock(body)).toEqual({
      title: "Handle large fences",
      body: "Look at this nesting:\n\n`````\ninner\n`````",
    });
  });

  test("parses a title that contains a single backtick (fence length stays 3)", () => {
    const body = [
      SQUASH_SUGGESTION_START_MARKER,
      "",
      "**Title**",
      "",
      "```text",
      "Rename `foo` to `bar`",
      "```",
      "",
      "**Body**",
      "",
      "```text",
      "See #9",
      "```",
      SQUASH_SUGGESTION_END_MARKER,
    ].join("\n");
    expect(parseSquashSuggestionBlock(body)).toEqual({
      title: "Rename `foo` to `bar`",
      body: "See #9",
    });
  });

  test("fenced format tolerates extra blank lines around fences", () => {
    const body = [
      SQUASH_SUGGESTION_START_MARKER,
      "",
      "**Title**",
      "",
      "",
      "```text",
      "T",
      "```",
      "",
      "",
      "**Body**",
      "",
      "",
      "```text",
      "B",
      "```",
      "",
      SQUASH_SUGGESTION_END_MARKER,
    ].join("\n");
    expect(parseSquashSuggestionBlock(body)).toEqual({
      title: "T",
      body: "B",
    });
  });

  test("returns undefined when the title fenced block is unterminated", () => {
    const body = [
      SQUASH_SUGGESTION_START_MARKER,
      "**Title**",
      "",
      "```text",
      "no close",
      "",
      "**Body**",
      "",
      "```text",
      "B",
      "```",
      SQUASH_SUGGESTION_END_MARKER,
    ].join("\n");
    expect(parseSquashSuggestionBlock(body)).toBeUndefined();
  });

  // ---- malformed / missing --------------------------------------------------

  test("returns undefined when the block has no title label or fence", () => {
    const body = [
      SQUASH_SUGGESTION_START_MARKER,
      "## Suggested squash commit",
      "",
      "Just some prose without labels or fences.",
      SQUASH_SUGGESTION_END_MARKER,
    ].join("\n");
    expect(parseSquashSuggestionBlock(body)).toBeUndefined();
  });

  test("returns undefined when markers are missing", () => {
    expect(parseSquashSuggestionBlock("no markers here")).toBeUndefined();
  });

  test("returns undefined for empty input", () => {
    expect(parseSquashSuggestionBlock(undefined)).toBeUndefined();
    expect(parseSquashSuggestionBlock("")).toBeUndefined();
  });

  test("returns undefined when title line is absent", () => {
    const body = `${SQUASH_SUGGESTION_START_MARKER}\nNo title here\n${SQUASH_SUGGESTION_END_MARKER}`;
    expect(parseSquashSuggestionBlock(body)).toBeUndefined();
  });

  // ---- legacy format rejection (regression) --------------------------------

  // The deprecated `**Title:** …` / `**Body:** …` plain-text format was
  // supported for one release cycle for backward compatibility with PRs
  // already in `applied_via_github` state.  Parsing it is now a hard
  // rejection — this test pins the new contract directly so the legacy
  // branch cannot silently reappear.
  test("returns undefined for a legacy `**Title:** … / **Body:** …` block", () => {
    const body = [
      "noise",
      SQUASH_SUGGESTION_START_MARKER,
      "## Suggested squash commit",
      "",
      "**Title:** Fix widget rendering",
      "",
      "**Body:**",
      "First line.",
      "",
      "Closes #42",
      SQUASH_SUGGESTION_END_MARKER,
      "more noise",
    ].join("\n");
    expect(parseSquashSuggestionBlock(body)).toBeUndefined();
  });

  // Combined regression for the screenshot incident on
  // aicers/aice-web-next#377: the agent-authored comment was missing
  // both the closing body fence AND the end marker.  Either flaw on its
  // own is already covered by an earlier case; the combined failure is
  // the one that actually shipped, so pin it directly.
  test("returns undefined when the body fence is unterminated AND the end marker is absent", () => {
    const body = [
      "noise",
      SQUASH_SUGGESTION_START_MARKER,
      "## Suggested squash commit",
      "",
      "**Title**",
      "",
      "```text",
      "Fix widget rendering",
      "```",
      "",
      "**Body**",
      "",
      "```text",
      "First line.",
      "",
      "Closes #42",
      // intentionally no closing body fence
      // intentionally no SQUASH_SUGGESTION_END_MARKER
      "more noise",
    ].join("\n");
    expect(parseSquashSuggestionBlock(body)).toBeUndefined();
  });
});

// ---- buildSquashSuggestionComment + round-trip ------------------------------

describe("buildSquashSuggestionComment ↔ parseSquashSuggestionBlock round-trip", () => {
  // Round-trip is the single strongest guarantee that the formatter and
  // parser stay in lock-step.  If one is changed without the other, one
  // of these cases fails — including the malformed-comment regression
  // class that motivated issue #304.
  function roundTrip(suggestion: { title: string; body: string }) {
    const built = buildSquashSuggestionComment(suggestion);
    const parsed = parseSquashSuggestionBlock(built);
    expect(parsed).toEqual(suggestion);
  }

  test("plain title and body", () => {
    roundTrip({
      title: "Fix widget rendering",
      body: "First line.\n\nCloses #42",
    });
  });

  test("body containing a triple-backtick fenced code sample", () => {
    roundTrip({
      title: "Improve docs",
      body: "Repro:\n\n```js\nfoo();\n```\n\nCloses #1",
    });
  });

  test("body containing a five-backtick run", () => {
    roundTrip({
      title: "Handle large fences",
      body: "Look at this nesting:\n\n`````\ninner\n`````\n\nPart of #9",
    });
  });

  test("body containing HTML comments", () => {
    roundTrip({
      title: "Preserve HTML comments",
      body:
        "<!-- review note: please check edge case -->\n\n" +
        "Closes #42\n\n<!-- end -->",
    });
  });

  test("title containing inline backticks (fence stays at 3)", () => {
    roundTrip({
      title: "Rename `foo` to `bar`",
      body: "See #9",
    });
  });

  test("body containing the start marker as a literal string", () => {
    // Defensive: even if the agent's prose contains the start marker,
    // the closing end marker still terminates the block correctly
    // because the parser anchors on the first end-marker occurrence
    // after the start.
    roundTrip({
      title: "Document the marker block",
      body: `The marker is \`${SQUASH_SUGGESTION_START_MARKER}\`.`,
    });
  });
});

// ---- parseSquashEnvelope ----------------------------------------------------

describe("parseSquashEnvelope", () => {
  test("returns ok for a well-formed envelope", () => {
    const text = [
      "Some prose before.",
      "",
      "<<<TITLE>>>",
      "Fix widget",
      "<<</TITLE>>>",
      "",
      "<<<BODY>>>",
      "First line.",
      "",
      "Closes #1",
      "<<</BODY>>>",
    ].join("\n");
    expect(parseSquashEnvelope(text)).toEqual({
      kind: "ok",
      suggestion: { title: "Fix widget", body: "First line.\n\nCloses #1" },
    });
  });

  test("returns missing when no envelope tag appears", () => {
    expect(parseSquashEnvelope("just plain text, no envelope")).toEqual({
      kind: "missing",
    });
  });

  test("returns malformed for missing TITLE close tag", () => {
    const text = "<<<TITLE>>>\nFix widget\n\n<<<BODY>>>\nB\n<<</BODY>>>";
    const result = parseSquashEnvelope(text);
    expect(result.kind).toBe("malformed");
    if (result.kind === "malformed") {
      expect(result.reason).toContain("</TITLE>");
    }
  });

  test("returns malformed for missing BODY close tag", () => {
    const text =
      "<<<TITLE>>>\nFix widget\n<<</TITLE>>>\n\n<<<BODY>>>\nFirst line.";
    const result = parseSquashEnvelope(text);
    expect(result.kind).toBe("malformed");
    if (result.kind === "malformed") {
      expect(result.reason).toContain("</BODY>");
    }
  });

  test("returns malformed for empty title", () => {
    const text = "<<<TITLE>>>\n   \n<<</TITLE>>>\n\n<<<BODY>>>\nB\n<<</BODY>>>";
    const result = parseSquashEnvelope(text);
    expect(result.kind).toBe("malformed");
    if (result.kind === "malformed") {
      expect(result.reason).toContain("title");
    }
  });

  test("returns malformed for empty body", () => {
    const text = "<<<TITLE>>>\nT\n<<</TITLE>>>\n\n<<<BODY>>>\n\n\n<<</BODY>>>";
    const result = parseSquashEnvelope(text);
    expect(result.kind).toBe("malformed");
    if (result.kind === "malformed") {
      expect(result.reason).toContain("body");
    }
  });

  test("preserves internal blank lines in body and strips leading/trailing", () => {
    const text =
      "<<<TITLE>>>\nT\n<<</TITLE>>>\n\n<<<BODY>>>\n\nfirst\n\nsecond\n\n<<</BODY>>>";
    expect(parseSquashEnvelope(text)).toEqual({
      kind: "ok",
      suggestion: { title: "T", body: "first\n\nsecond" },
    });
  });
});

// ---- postOrUpdateSquashSuggestion -------------------------------------------

describe("postOrUpdateSquashSuggestion", () => {
  test("PATCHes the existing comment when one with the start marker exists", () => {
    const findLatest = vi
      .fn()
      .mockReturnValue({ id: 555, body: "stale body with marker" });
    const patch = vi.fn();
    const post = vi.fn();

    postOrUpdateSquashSuggestion("org", "repo", 42, "new body", {
      findLatest,
      patch,
      post,
    });

    expect(findLatest).toHaveBeenCalledWith(
      "org",
      "repo",
      42,
      SQUASH_SUGGESTION_START_MARKER,
    );
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("org", "repo", 555, "new body");
    expect(post).not.toHaveBeenCalled();
  });

  test("POSTs a new comment when no prior comment matches", () => {
    const findLatest = vi.fn().mockReturnValue(undefined);
    const patch = vi.fn();
    const post = vi.fn();

    postOrUpdateSquashSuggestion("org", "repo", 42, "fresh body", {
      findLatest,
      patch,
      post,
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("org", "repo", 42, "fresh body");
    expect(patch).not.toHaveBeenCalled();
  });

  test("falls back to POST when prior comment lacks an id", () => {
    // Older fixtures (and stub adapters) may surface a body without
    // the comment id.  Without an id we cannot PATCH, so the helper
    // falls back to POST rather than throwing.
    const findLatest = vi
      .fn()
      .mockReturnValue({ id: undefined, body: "stale" });
    const patch = vi.fn();
    const post = vi.fn();

    postOrUpdateSquashSuggestion("org", "repo", 42, "new body", {
      findLatest,
      patch,
      post,
    });

    expect(patch).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith("org", "repo", 42, "new body");
  });
});

// ---- envelope-driven SUGGESTED_SINGLE in createSquashStageHandler ----------

describe("envelope-driven SUGGESTED_SINGLE flow", () => {
  function makeEnvelopeAgent(envelope: string): AgentAdapter {
    return {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-squash",
            responseText: envelope,
          }),
        ),
      ),
      // Follow-up resume for the agent-squash branch.
      resume: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-followup",
            responseText: "Squashed and pushed.",
          }),
        ),
      ),
    };
  }

  test("agent returns envelope → code authors comment, skips verdict turn, asks user", async () => {
    const envelopeText = [
      "Looking at the branch...",
      "",
      "<<<TITLE>>>",
      "Fix the widget",
      "<<</TITLE>>>",
      "",
      "<<<BODY>>>",
      "Refactor renderer.",
      "",
      "Closes #42",
      "<<</BODY>>>",
    ].join("\n");
    const agent = makeEnvelopeAgent(envelopeText);
    const postSuggestionComment = vi.fn();
    const chooseSquashApplyMode = vi.fn().mockResolvedValue("github");
    const onSquashSubStep = vi.fn();
    const opts = makeOpts({
      agent,
      chooseSquashApplyMode,
      postSuggestionComment,
      onSquashSubStep,
    });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    // Verdict turn was skipped because the envelope was present.
    expect(agent.resume).not.toHaveBeenCalled();
    // The code authored the comment and posted it via the injectable.
    expect(postSuggestionComment).toHaveBeenCalledTimes(1);
    const [postedOwner, postedRepo, postedPr, postedBody] =
      postSuggestionComment.mock.calls[0];
    expect(postedOwner).toBe("org");
    expect(postedRepo).toBe("repo");
    expect(postedPr).toBe(42);
    // Round-trip: the parser must agree with what the formatter wrote.
    expect(parseSquashSuggestionBlock(postedBody)).toEqual({
      title: "Fix the widget",
      body: "Refactor renderer.\n\nCloses #42",
    });
    expect(chooseSquashApplyMode).toHaveBeenCalledTimes(1);
    const states = onSquashSubStep.mock.calls.map((c) => c[0]);
    expect(states).toContain("planning");
    expect(states).toContain("awaiting_user_choice");
    expect(states[states.length - 1]).toBe("applied_via_github");
  });

  test("agent returns envelope + user picks agent → follow-up resumes the planning session", async () => {
    const envelopeText =
      "<<<TITLE>>>\nT\n<<</TITLE>>>\n\n<<<BODY>>>\nB\n<<</BODY>>>";
    const agent = makeEnvelopeAgent(envelopeText);
    const postSuggestionComment = vi.fn();
    const chooseSquashApplyMode = vi.fn().mockResolvedValue("agent");
    const opts = makeOpts({
      agent,
      chooseSquashApplyMode,
      postSuggestionComment,
    });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("CI passed");
    // No verdict turn — only the agent-squash follow-up resume.
    expect(agent.resume).toHaveBeenCalledTimes(1);
    expect((agent.resume as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      "sess-squash",
    );
    expect(postSuggestionComment).toHaveBeenCalledTimes(1);
  });

  test("envelope present + pipeline:verdict event surfaces SUGGESTED_SINGLE", async () => {
    const envelopeText =
      "<<<TITLE>>>\nT\n<<</TITLE>>>\n\n<<<BODY>>>\nB\n<<</BODY>>>";
    const agent = makeEnvelopeAgent(envelopeText);
    const events = new PipelineEventEmitter();
    const handler = vi.fn();
    events.on("pipeline:verdict", handler);
    const opts = makeOpts({
      agent,
      postSuggestionComment: vi.fn(),
      chooseSquashApplyMode: vi.fn().mockResolvedValue("github"),
    });
    const stage = createSquashStageHandler(opts);
    await stage.handler({ ...BASE_CTX, events });

    const keywords = handler.mock.calls.map((c) => c[0].keyword);
    expect(keywords).toContain("SUGGESTED_SINGLE");
  });

  // Malformed envelope → blocked with an actionable message.  Cover the
  // three categories the issue calls out: missing close tag, empty title,
  // empty body.
  test.each([
    {
      name: "missing TITLE close tag",
      envelope: "<<<TITLE>>>\nFix widget\n\n<<<BODY>>>\nB\n<<</BODY>>>",
      expectedFragment: "</TITLE>",
    },
    {
      name: "empty title",
      envelope: "<<<TITLE>>>\n   \n<<</TITLE>>>\n\n<<<BODY>>>\nB\n<<</BODY>>>",
      expectedFragment: "title",
    },
    {
      name: "empty body",
      envelope: "<<<TITLE>>>\nT\n<<</TITLE>>>\n\n<<<BODY>>>\n\n<<</BODY>>>",
      expectedFragment: "body",
    },
  ])("malformed envelope ($name) → blocked, no comment posted, no user choice", async ({
    envelope,
    expectedFragment,
  }) => {
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sess-squash",
            responseText: envelope,
          }),
        ),
      ),
      resume: vi.fn(),
    };
    const postSuggestionComment = vi.fn();
    const chooseSquashApplyMode = vi.fn();
    const onSquashSubStep = vi.fn();
    const opts = makeOpts({
      agent,
      postSuggestionComment,
      chooseSquashApplyMode,
      onSquashSubStep,
    });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("blocked");
    expect(result.message).toContain("envelope malformed");
    expect(result.message).toContain(expectedFragment);
    // The verdict turn must NOT have run — the malformed envelope
    // already declares intent to take the SUGGESTED_SINGLE branch.
    expect(agent.resume).not.toHaveBeenCalled();
    expect(postSuggestionComment).not.toHaveBeenCalled();
    expect(chooseSquashApplyMode).not.toHaveBeenCalled();
    const states = onSquashSubStep.mock.calls.map((c) => c[0]);
    expect(states).not.toContain("awaiting_user_choice");
    expect(states).not.toContain("applied_via_github");
    expect(states[states.length - 1]).toBe(undefined);
  });

  test("envelope absent → falls through to existing verdict flow", async () => {
    // Plain "Plan." response with no envelope tags should not trigger
    // the new envelope-driven shortcut.  The verdict turn runs as
    // before and the SQUASHED_MULTI branch proceeds to CI poll.
    const opts = makeOpts({ postSuggestionComment: vi.fn() });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(opts.agent.resume).toHaveBeenCalled();
    expect(opts.postSuggestionComment).not.toHaveBeenCalled();
  });
});
