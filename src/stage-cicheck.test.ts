import { describe, expect, test, vi } from "vitest";
import type { AgentAdapter, AgentResult, AgentStream } from "./agent.js";
import type { CiInspectionContext, CiRun, CiStatus, CiVerdict } from "./ci.js";
import type { StageContext } from "./pipeline.js";
import {
  buildCiFindingsPrompt,
  buildCiFixPrompt,
  type CiCheckStageOptions,
  createCiCheckStageHandler,
} from "./stage-cicheck.js";

// ---- helpers ---------------------------------------------------------------

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    sessionId: "sess-1",
    responseText: "Fixed the CI failures.",
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
  return { verdict, runs };
}

function makeInspection(
  overrides: Partial<CiInspectionContext> = {},
): CiInspectionContext {
  return {
    workflowRuns: [],
    checkRunIds: [],
    hasAnnotations: false,
    annotationsIncomplete: false,
    ref: "abc123",
    ...overrides,
  };
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
  overrides: Partial<CiCheckStageOptions> = {},
): CiCheckStageOptions {
  return {
    agent: {
      invoke: vi.fn().mockReturnValue(makeStream(makeResult())),
      resume: vi.fn().mockReturnValue(makeStream(makeResult())),
    },
    issueTitle: "Fix the widget",
    issueBody: "The widget is broken.",
    getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
    getHeadSha: vi.fn().mockReturnValue("abc123"),
    buildCiInspectionContext: vi.fn().mockReturnValue(makeInspection()),
    delay: vi.fn().mockResolvedValue(undefined),
    pollIntervalMs: 100,
    pollTimeoutMs: 1000,
    emptyRunsGracePeriodMs: 0,
    ...overrides,
  };
}

// ---- buildCiFixPrompt ------------------------------------------------------

describe("buildCiFixPrompt", () => {
  test("includes issue details", () => {
    const prompt = buildCiFixPrompt(BASE_CTX, makeOpts(), makeInspection());
    expect(prompt).toContain("Issue #42: Fix the widget");
    expect(prompt).toContain("The widget is broken.");
  });

  test("includes the inspection context block, not raw failure logs", () => {
    const inspection = makeInspection({
      workflowRuns: [
        { runId: 12345, failedJobs: [{ id: 555, name: "build" }] },
      ],
      ref: "deadbeef",
    });
    const prompt = buildCiFixPrompt(BASE_CTX, makeOpts(), inspection);
    expect(prompt).toContain("CI Inspection Context");
    expect(prompt).toContain("12345");
    expect(prompt).toContain("555");
    expect(prompt).toContain("deadbeef");
    expect(prompt).not.toContain("CI Failure Logs");
  });

  test("does not embed raw log content even when given a large status", () => {
    // Even though no logs are passed in, this guards the structural
    // contract: the builder takes only pointers and never log bodies.
    const inspection = makeInspection({
      workflowRuns: Array.from({ length: 10 }, (_, i) => ({
        runId: i,
        failedJobs: [{ id: 1000 + i, name: `job-${i}` }],
      })),
    });
    const prompt = buildCiFixPrompt(BASE_CTX, makeOpts(), inspection);
    // Bounded prompt: well under the 4 KiB threshold from the spec
    // because no log bodies are inlined.
    expect(prompt.length).toBeLessThan(4096);
  });

  test("hints at gh run view --log-failed for the agent to fetch logs", () => {
    const prompt = buildCiFixPrompt(BASE_CTX, makeOpts(), makeInspection());
    expect(prompt).toContain("gh run view");
    expect(prompt).toContain("--log-failed");
  });

  test("instructs to commit and push", () => {
    const prompt = buildCiFixPrompt(BASE_CTX, makeOpts(), makeInspection());
    expect(prompt).toContain("commit and push");
  });

  test("includes doc consistency instructions", () => {
    const prompt = buildCiFixPrompt(BASE_CTX, makeOpts(), makeInspection());
    expect(prompt).toContain("CHANGELOG");
    expect(prompt).toContain("MkDocs");
  });

  test("includes user instruction when present", () => {
    const ctx = { ...BASE_CTX, userInstruction: "Ignore lint warnings" };
    const prompt = buildCiFixPrompt(ctx, makeOpts(), makeInspection());
    expect(prompt).toContain("Additional feedback");
    expect(prompt).toContain("Ignore lint warnings");
  });

  test("omits feedback section when no instruction", () => {
    const prompt = buildCiFixPrompt(BASE_CTX, makeOpts(), makeInspection());
    expect(prompt).not.toContain("Additional feedback");
  });

  test("surfaces annotationsIncomplete with a re-fetch hint", () => {
    const prompt = buildCiFixPrompt(
      BASE_CTX,
      makeOpts(),
      makeInspection({ annotationsIncomplete: true }),
    );
    expect(prompt).toContain("annotationsIncomplete");
    expect(prompt).toContain("partial");
  });
});

// ---- createCiCheckStageHandler ---------------------------------------------

describe("createCiCheckStageHandler", () => {
  test("returns stage definition with number 5 and name CI check", () => {
    const stage = createCiCheckStageHandler(makeOpts());
    expect(stage.number).toBe(5);
    expect(stage.name).toBe("CI check");
  });

  test("does not set requiresArtifact", () => {
    const stage = createCiCheckStageHandler(makeOpts());
    expect(stage.requiresArtifact).toBeUndefined();
  });

  // -- CI passes immediately -------------------------------------------------

  test("returns completed when CI passes on first poll", async () => {
    const opts = makeOpts({
      getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
    });
    const stage = createCiCheckStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("CI checks passed");
    expect(opts.agent.invoke).not.toHaveBeenCalled();
  });

  // -- CI pending then passes ------------------------------------------------

  test("polls when pending then returns completed on pass", async () => {
    const getCiStatus = vi
      .fn()
      .mockReturnValueOnce(makeCiStatus("pending"))
      .mockReturnValueOnce(makeCiStatus("pending"))
      .mockReturnValueOnce(makeCiStatus("pass"));
    const delay = vi.fn().mockResolvedValue(undefined);

    const opts = makeOpts({ getCiStatus, delay });
    const stage = createCiCheckStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(getCiStatus).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(opts.agent.invoke).not.toHaveBeenCalled();
  });

  // -- CI pending timeout ----------------------------------------------------

  test("returns error when pending exceeds timeout", async () => {
    const getCiStatus = vi.fn().mockReturnValue(makeCiStatus("pending"));
    let elapsed = 0;
    const originalNow = Date.now;
    const startTime = originalNow();
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
    const stage = createCiCheckStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("still pending");

    vi.restoreAllMocks();
  });

  // -- CI fails — agent fix flow ---------------------------------------------

  test("builds inspection context and invokes agent on CI failure", async () => {
    const failedRun = makeCiRun({
      databaseId: 200,
      name: "test-suite",
      conclusion: "failure",
    });
    const getCiStatus = vi
      .fn()
      .mockReturnValue(makeCiStatus("fail", [failedRun]));
    const buildCiInspectionContext = vi.fn().mockReturnValue(
      makeInspection({
        workflowRuns: [{ runId: 200, failedJobs: [{ id: 999, name: "test" }] }],
      }),
    );

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(makeResult())),
      resume: vi.fn().mockReturnValue(makeStream(makeResult())),
    };

    const opts = makeOpts({ agent, getCiStatus, buildCiInspectionContext });
    const stage = createCiCheckStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(buildCiInspectionContext).toHaveBeenCalledWith(
      "org",
      "repo",
      "abc123",
      expect.objectContaining({ verdict: "fail" }),
    );
    expect(agent.invoke).toHaveBeenCalledWith(
      expect.stringContaining("CI Inspection Context"),
      { cwd: "/tmp/wt" },
    );
    const invokedPrompt = (agent.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    // Pointer block is present.
    expect(invokedPrompt).toContain("200");
    expect(invokedPrompt).toContain("999");
    // No raw log content was inlined.
    expect(invokedPrompt).not.toContain("CI Failure Logs");
    expect(result.outcome).toBe("not_approved");
  });

  test("returns not_approved after agent fix to trigger engine loop", async () => {
    const getCiStatus = vi
      .fn()
      .mockReturnValue(
        makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]),
      );

    const opts = makeOpts({ getCiStatus });
    const stage = createCiCheckStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("not_approved");
  });

  test("includes user instruction in fix prompt when present", async () => {
    const failedRun = makeCiRun({ conclusion: "failure" });
    const getCiStatus = vi
      .fn()
      .mockReturnValue(makeCiStatus("fail", [failedRun]));

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(makeResult())),
      resume: vi.fn().mockReturnValue(makeStream(makeResult())),
    };

    const ctx = { ...BASE_CTX, userInstruction: "Skip the flaky e2e test" };
    const opts = makeOpts({ agent, getCiStatus });
    const stage = createCiCheckStageHandler(opts);
    await stage.handler(ctx);

    const invokedPrompt = (agent.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(invokedPrompt).toContain("Skip the flaky e2e test");
  });

  // -- error handling --------------------------------------------------------

  test("returns error when agent fix call fails", async () => {
    const getCiStatus = vi
      .fn()
      .mockReturnValue(
        makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]),
      );

    const agent: AgentAdapter = {
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

    const opts = makeOpts({ agent, getCiStatus });
    const stage = createCiCheckStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("crash");
    expect(result.message).toContain("CI fix");
  });

  test("retries on transient getCiStatus error then succeeds", async () => {
    const getCiStatus = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("network timeout");
      })
      .mockReturnValueOnce(makeCiStatus("pass"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const opts = makeOpts({ getCiStatus });
    const stage = createCiCheckStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(getCiStatus).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("network timeout");

    warnSpy.mockRestore();
  });

  test("returns timeout error when getCiStatus keeps failing", async () => {
    const getCiStatus = vi.fn().mockImplementation(() => {
      throw new Error("persistent API error");
    });

    let elapsed = 0;
    const startTime = Date.now();
    const delay = vi.fn().mockImplementation(async () => {
      elapsed += 500;
    });
    vi.spyOn(Date, "now").mockImplementation(() => startTime + elapsed);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const opts = makeOpts({ getCiStatus, delay, pollTimeoutMs: 1000 });
    const stage = createCiCheckStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("still pending");
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    vi.restoreAllMocks();
  });

  // -- message preservation --------------------------------------------------

  test("reads HEAD SHA and forwards to getCiStatus", async () => {
    const getCiStatus = vi.fn().mockReturnValue(makeCiStatus("pass"));
    const getHeadSha = vi.fn().mockReturnValue("deadbeef");
    const opts = makeOpts({ getCiStatus, getHeadSha });
    const stage = createCiCheckStageHandler(opts);
    await stage.handler(BASE_CTX);

    expect(getHeadSha).toHaveBeenCalledWith("/tmp/wt");
    expect(getCiStatus).toHaveBeenCalledWith(
      "org",
      "repo",
      "issue-42",
      "deadbeef",
    );
  });

  test("re-reads HEAD SHA on each poll cycle", async () => {
    let shaCall = 0;
    const shas = ["aaa111", "bbb222", "bbb222"];
    const getHeadSha = vi.fn().mockImplementation(() => shas[shaCall++]);
    const getCiStatus = vi
      .fn()
      .mockReturnValueOnce(makeCiStatus("pending"))
      .mockReturnValueOnce(makeCiStatus("pending"))
      .mockReturnValueOnce(makeCiStatus("pass"));

    const opts = makeOpts({
      getCiStatus,
      getHeadSha,
      delay: vi.fn().mockResolvedValue(undefined),
    });
    const stage = createCiCheckStageHandler(opts);
    await stage.handler(BASE_CTX);

    expect(getHeadSha).toHaveBeenCalledTimes(3);
    expect(getCiStatus).toHaveBeenNthCalledWith(
      1,
      "org",
      "repo",
      "issue-42",
      "aaa111",
    );
    expect(getCiStatus).toHaveBeenNthCalledWith(
      2,
      "org",
      "repo",
      "issue-42",
      "bbb222",
    );
  });

  test("waits within grace period when SHA filter returns empty pass", async () => {
    const getHeadSha = vi.fn().mockReturnValue("new-sha");
    const getCiStatus = vi
      .fn()
      .mockReturnValueOnce(makeCiStatus("pass")) // empty, within grace
      .mockReturnValueOnce(makeCiStatus("pass", [makeCiRun()])); // runs appeared

    let elapsed = 0;
    const startTime = Date.now();
    const delay = vi.fn().mockImplementation(async () => {
      elapsed += 100;
    });
    vi.spyOn(Date, "now").mockImplementation(() => startTime + elapsed);

    const opts = makeOpts({
      getCiStatus,
      getHeadSha,
      delay,
      emptyRunsGracePeriodMs: 500,
    });
    const stage = createCiCheckStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(getCiStatus).toHaveBeenCalledTimes(2);

    vi.restoreAllMocks();
  });

  test("accepts empty pass after grace period expires (no CI)", async () => {
    const getHeadSha = vi.fn().mockReturnValue("new-sha");
    const getCiStatus = vi.fn().mockReturnValue(makeCiStatus("pass"));

    let elapsed = 0;
    const startTime = Date.now();
    const delay = vi.fn().mockImplementation(async () => {
      elapsed += 300;
    });
    vi.spyOn(Date, "now").mockImplementation(() => startTime + elapsed);

    const opts = makeOpts({
      getCiStatus,
      getHeadSha,
      delay,
      emptyRunsGracePeriodMs: 500,
      pollIntervalMs: 100,
    });
    const stage = createCiCheckStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("CI checks passed");

    vi.restoreAllMocks();
  });

  test("preserves agent fix response text in message", async () => {
    const getCiStatus = vi
      .fn()
      .mockReturnValue(
        makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]),
      );
    const fixResponse = "Fixed the linting issue and pushed.";

    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: fixResponse }))),
      resume: vi.fn(),
    };

    const opts = makeOpts({ agent, getCiStatus });
    const stage = createCiCheckStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.message).toBe(fixResponse);
  });

  // -- CI passes with annotations — agent reviews -----------------------------

  test("presents pointer-only review prompt when CI passes with annotations", async () => {
    const checkRun = makeCiRun({
      databaseId: 500,
      name: "ESLint",
      source: "check",
      annotationsCount: 3,
    });
    const getCiStatus = vi
      .fn()
      .mockReturnValue(makeCiStatus("pass", [checkRun]));
    const getHeadSha = vi.fn().mockReturnValue("same-sha");
    const buildCiInspectionContext = vi.fn().mockReturnValue(
      makeInspection({
        checkRunIds: [500],
        hasAnnotations: true,
      }),
    );

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(makeResult())),
      resume: vi.fn().mockReturnValue(makeStream(makeResult())),
    };

    const opts = makeOpts({
      agent,
      getCiStatus,
      getHeadSha,
      buildCiInspectionContext,
    });
    const stage = createCiCheckStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(agent.invoke).toHaveBeenCalledWith(
      expect.stringContaining("CI Inspection Context"),
      expect.any(Object),
    );
    const invokedPrompt = (agent.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    // Check run ID is referenced for the agent to fetch.
    expect(invokedPrompt).toContain("500");
    // No serialised findings inlined.
    expect(invokedPrompt).not.toContain("CI Findings");
    // Triage block present (since we always emit it on the findings prompt).
    expect(invokedPrompt).toContain("Triage of code scanning alerts");
    expect(invokedPrompt).toContain("dismissed_reason=false positive");

    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("Findings were reviewed");
  });

  test("returns not_approved when agent pushes a fix for findings", async () => {
    const checkRun = makeCiRun({
      databaseId: 600,
      source: "check",
      annotationsCount: 1,
    });
    const getCiStatus = vi
      .fn()
      .mockReturnValue(makeCiStatus("pass", [checkRun]));

    let shaCall = 0;
    const shas = ["before-sha", "before-sha", "after-sha"];
    const getHeadSha = vi.fn().mockImplementation(() => shas[shaCall++]);

    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "Fixed the import." })),
        ),
      resume: vi.fn(),
    };

    const opts = makeOpts({ agent, getCiStatus, getHeadSha });
    const stage = createCiCheckStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("not_approved");
    expect(result.message).toBe("Fixed the import.");
  });

  test("returns error when agent fails during findings review", async () => {
    const checkRun = makeCiRun({
      databaseId: 500,
      source: "check",
      annotationsCount: 2,
    });
    const getCiStatus = vi
      .fn()
      .mockReturnValue(makeCiStatus("pass", [checkRun]));
    const getHeadSha = vi.fn().mockReturnValue("sha");

    const agent: AgentAdapter = {
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

    const opts = makeOpts({ agent, getCiStatus, getHeadSha });
    const stage = createCiCheckStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("findings review");
  });

  test("returns completed with clean pass when no annotations", async () => {
    const getCiStatus = vi
      .fn()
      .mockReturnValue(makeCiStatus("pass", [makeCiRun()]));

    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi.fn(),
    };

    const opts = makeOpts({ agent, getCiStatus });
    const stage = createCiCheckStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("CI checks passed");
    expect(agent.invoke).not.toHaveBeenCalled();
  });

  test("includes user instruction in findings prompt", async () => {
    const checkRun = makeCiRun({
      databaseId: 500,
      source: "check",
      annotationsCount: 1,
    });
    const getCiStatus = vi
      .fn()
      .mockReturnValue(makeCiStatus("pass", [checkRun]));
    const getHeadSha = vi.fn().mockReturnValue("same-sha");

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(makeResult())),
      resume: vi.fn().mockReturnValue(makeStream(makeResult())),
    };

    const ctx = {
      ...BASE_CTX,
      userInstruction: "Ignore the unused variable warnings",
    };
    const opts = makeOpts({ agent, getCiStatus, getHeadSha });
    const stage = createCiCheckStageHandler(opts);
    await stage.handler(ctx);

    const invokedPrompt = (agent.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(invokedPrompt).toContain("Ignore the unused variable warnings");
  });
});

// ---- buildCiFindingsPrompt --------------------------------------------------

describe("buildCiFindingsPrompt", () => {
  test("includes issue details", () => {
    const prompt = buildCiFindingsPrompt(
      BASE_CTX,
      makeOpts(),
      makeInspection({ hasAnnotations: true, checkRunIds: [500] }),
    );
    expect(prompt).toContain("Issue #42: Fix the widget");
    expect(prompt).toContain("The widget is broken.");
  });

  test("includes the inspection context block, not a serialised findings list", () => {
    const prompt = buildCiFindingsPrompt(
      BASE_CTX,
      makeOpts(),
      makeInspection({ hasAnnotations: true, checkRunIds: [100, 200] }),
    );
    expect(prompt).toContain("CI Inspection Context");
    expect(prompt).toContain("100");
    expect(prompt).toContain("200");
    // Old "CI Findings" header is gone — replaced by pointer + fetch hints.
    expect(prompt).not.toContain("## CI Findings");
  });

  test("hints at gh fetch commands so the agent reads annotations itself", () => {
    const prompt = buildCiFindingsPrompt(
      BASE_CTX,
      makeOpts(),
      makeInspection({ hasAnnotations: true, checkRunIds: [42] }),
    );
    expect(prompt).toContain("gh api");
    expect(prompt).toContain("/check-runs/");
    expect(prompt).toContain("/annotations");
    expect(prompt).toContain("/code-scanning/alerts");
  });

  test("includes triage block with dismiss instructions", () => {
    const prompt = buildCiFindingsPrompt(
      BASE_CTX,
      makeOpts(),
      makeInspection({ hasAnnotations: true, checkRunIds: [42] }),
    );
    expect(prompt).toContain("Triage of code scanning alerts");
    expect(prompt).toContain("Evaluation criteria");
    expect(prompt).toContain("real issue");
    expect(prompt).toContain("false positive");
    expect(prompt).toContain("gh api -X PATCH");
    expect(prompt).toContain("dismissed_reason=false positive");
    expect(prompt).toContain("gh pr view");
  });

  test("flags annotationsIncomplete with a re-fetch hint", () => {
    const prompt = buildCiFindingsPrompt(
      BASE_CTX,
      makeOpts(),
      makeInspection({
        hasAnnotations: true,
        annotationsIncomplete: true,
        checkRunIds: [10],
      }),
    );
    expect(prompt).toContain("annotationsIncomplete");
    expect(prompt).toContain("partial");
  });

  test("includes user instruction when present", () => {
    const ctx = { ...BASE_CTX, userInstruction: "Focus on warnings only" };
    const prompt = buildCiFindingsPrompt(
      ctx,
      makeOpts(),
      makeInspection({ hasAnnotations: true, checkRunIds: [1] }),
    );
    expect(prompt).toContain("Additional feedback");
    expect(prompt).toContain("Focus on warnings only");
  });

  test("stays bounded for many check runs", () => {
    const prompt = buildCiFindingsPrompt(
      BASE_CTX,
      makeOpts(),
      makeInspection({
        hasAnnotations: true,
        checkRunIds: Array.from({ length: 200 }, (_, i) => i),
      }),
    );
    // 200 check-run IDs should still be small compared to inlining
    // 200 alert payloads.
    expect(prompt.length).toBeLessThan(8000);
  });
});
