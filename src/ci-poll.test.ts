import { describe, expect, test, vi } from "vitest";
import type { AgentAdapter, AgentResult, AgentStream } from "./agent.js";
import type { CiFinding, CiRun, CiStatus, CiVerdict } from "./ci.js";
import { type CiPollOptions, pollCiAndFix } from "./ci-poll.js";
import type { StageContext } from "./pipeline.js";
import {
  type PipelineCiPollEvent,
  PipelineEventEmitter,
} from "./pipeline-events.js";

// ---- helpers ---------------------------------------------------------------

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    sessionId: "sess-1",
    responseText: "Fixed.",
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

function makeCiStatus(
  verdict: CiVerdict,
  runs: CiRun[] = [],
  findings: CiFinding[] = [],
  findingsIncomplete = false,
): CiStatus {
  return { verdict, runs, findings, findingsIncomplete };
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

function makeAgent(invokeResult?: AgentResult): AgentAdapter {
  return {
    invoke: vi.fn().mockReturnValue(makeStream(invokeResult ?? makeResult())),
    resume: vi.fn(),
  };
}

function makeOpts(overrides: Partial<CiPollOptions> = {}): CiPollOptions {
  return {
    ctx: BASE_CTX,
    agent: makeAgent(),
    issueTitle: "Fix the widget",
    issueBody: "The widget is broken.",
    getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
    collectFailureLogs: vi.fn().mockReturnValue(""),
    getHeadSha: vi.fn().mockReturnValue("abc123"),
    fetchCodeScanningAlerts: vi.fn().mockReturnValue([]),
    delay: vi.fn().mockResolvedValue(undefined),
    pollIntervalMs: 100,
    pollTimeoutMs: 1000,
    maxFixAttempts: 3,
    emptyRunsGracePeriodMs: 0,
    ...overrides,
  };
}

// ---- pollCiAndFix -----------------------------------------------------------

describe("pollCiAndFix", () => {
  // -- CI passes immediately --------------------------------------------------

  test("returns passed when CI passes on first poll", async () => {
    const opts = makeOpts({
      getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
    });
    const result = await pollCiAndFix(opts);

    expect(result.passed).toBe(true);
    expect(result.message).toContain("CI checks passed");
    expect(opts.agent.invoke).not.toHaveBeenCalled();
  });

  // -- CI pending then passes -------------------------------------------------

  test("polls when pending then returns passed on pass", async () => {
    const getCiStatus = vi
      .fn()
      .mockReturnValueOnce(makeCiStatus("pending"))
      .mockReturnValueOnce(makeCiStatus("pending"))
      .mockReturnValueOnce(makeCiStatus("pass"));
    const delay = vi.fn().mockResolvedValue(undefined);

    const result = await pollCiAndFix(makeOpts({ getCiStatus, delay }));

    expect(result.passed).toBe(true);
    expect(getCiStatus).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
  });

  // -- CI pending timeout -----------------------------------------------------

  test("returns error when CI pending exceeds timeout", async () => {
    const getCiStatus = vi.fn().mockReturnValue(makeCiStatus("pending"));
    let elapsed = 0;
    const startTime = Date.now();
    const delay = vi.fn().mockImplementation(async () => {
      elapsed += 500;
    });
    vi.spyOn(Date, "now").mockImplementation(() => startTime + elapsed);

    const result = await pollCiAndFix(
      makeOpts({
        getCiStatus,
        delay,
        pollIntervalMs: 100,
        pollTimeoutMs: 1000,
      }),
    );

    expect(result.passed).toBe(false);
    expect(result.message).toContain("still pending");

    vi.restoreAllMocks();
  });

  // -- CI fails then fix succeeds ---------------------------------------------

  test("invokes agent to fix on CI failure, passes on next poll", async () => {
    const failedRun = makeCiRun({
      databaseId: 200,
      name: "test-suite",
      conclusion: "failure",
    });
    const getCiStatus = vi
      .fn()
      .mockReturnValueOnce(makeCiStatus("fail", [failedRun]))
      .mockReturnValueOnce(makeCiStatus("pass"));
    const collectFailureLogs = vi
      .fn()
      .mockReturnValue("Error: test failed at line 42");

    const agent = makeAgent();
    const result = await pollCiAndFix(
      makeOpts({ agent, getCiStatus, collectFailureLogs }),
    );

    expect(result.passed).toBe(true);
    expect(agent.invoke).toHaveBeenCalledTimes(1);
    expect(collectFailureLogs).toHaveBeenCalledWith(
      "org",
      "repo",
      expect.objectContaining({ databaseId: 200 }),
    );
    const invokedPrompt = (agent.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(invokedPrompt).toContain("CI Failure Logs");
    expect(invokedPrompt).toContain("Error: test failed at line 42");
  });

  // -- CI fails, all fix attempts exhausted -----------------------------------

  test("returns error after maxFixAttempts exhausted", async () => {
    const getCiStatus = vi
      .fn()
      .mockReturnValue(
        makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]),
      );
    const collectFailureLogs = vi.fn().mockReturnValue("err");

    const invokeResults = [
      makeStream(makeResult({ responseText: "Fix 1." })),
      makeStream(makeResult({ responseText: "Fix 2." })),
      makeStream(makeResult({ responseText: "Fix 3." })),
    ];
    let call = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => invokeResults[call++]),
      resume: vi.fn(),
    };

    const result = await pollCiAndFix(
      makeOpts({ agent, getCiStatus, collectFailureLogs, maxFixAttempts: 3 }),
    );

    expect(result.passed).toBe(false);
    expect(result.message).toContain("still failing after 3 fix attempt");
    expect(agent.invoke).toHaveBeenCalledTimes(3);
  });

  // -- agent error during fix -------------------------------------------------

  test("returns error when agent fails during CI fix", async () => {
    const getCiStatus = vi
      .fn()
      .mockReturnValue(
        makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]),
      );
    const collectFailureLogs = vi.fn().mockReturnValue("err");
    const agent = makeAgent(
      makeResult({
        status: "error",
        errorType: "execution_error",
        stderrText: "crash",
        responseText: "",
      }),
    );

    const result = await pollCiAndFix(
      makeOpts({ agent, getCiStatus, collectFailureLogs }),
    );

    expect(result.passed).toBe(false);
    expect(result.message).toContain("Agent error during CI fix");
    expect(result.message).toContain("crash");
  });

  // -- agent error during fix logs diagnostics --------------------------------

  test("logs raw diagnostics when agent fails during CI fix", async () => {
    const getCiStatus = vi
      .fn()
      .mockReturnValue(
        makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]),
      );
    const collectFailureLogs = vi.fn().mockReturnValue("err");
    const agent = makeAgent(
      makeResult({
        status: "error",
        errorType: "execution_error",
        exitCode: 1,
        signal: "SIGTERM",
        stderrText: "segfault",
        responseText: "",
      }),
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await pollCiAndFix(makeOpts({ agent, getCiStatus, collectFailureLogs }));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls[0][0] as string;
    expect(logged).toContain("during CI fix");
    expect(logged).toContain("errorType=execution_error");
    expect(logged).toContain("exitCode=1");
    expect(logged).toContain("signal=SIGTERM");
    expect(logged).toContain("stderr=segfault");

    errorSpy.mockRestore();
  });

  // -- multiple failed runs with logs -----------------------------------------

  test("collects logs from multiple failed runs", async () => {
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

    const agent = makeAgent();
    await pollCiAndFix(makeOpts({ agent, getCiStatus, collectFailureLogs }));

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

    const invokedPrompt = (agent.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(invokedPrompt).toContain("lint: unused var");
    expect(invokedPrompt).toContain("test: assertion failed");
  });

  // -- no detailed failure logs -----------------------------------------------

  test("handles empty failure logs gracefully", async () => {
    const runs = [makeCiRun({ conclusion: "failure" })];
    const getCiStatus = vi
      .fn()
      .mockReturnValueOnce(makeCiStatus("fail", runs))
      .mockReturnValueOnce(makeCiStatus("pass"));
    const collectFailureLogs = vi.fn().mockReturnValue("");

    const agent = makeAgent();
    await pollCiAndFix(makeOpts({ agent, getCiStatus, collectFailureLogs }));

    const invokedPrompt = (agent.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(invokedPrompt).toContain("No detailed failure logs available");
  });

  // -- cancelled runs are treated as failures ---------------------------------

  test("collects logs from cancelled runs", async () => {
    const runs = [makeCiRun({ databaseId: 300, conclusion: "cancelled" })];
    const getCiStatus = vi
      .fn()
      .mockReturnValueOnce(makeCiStatus("fail", runs))
      .mockReturnValueOnce(makeCiStatus("pass"));
    const collectFailureLogs = vi.fn().mockReturnValue("cancelled log");

    const agent = makeAgent();
    await pollCiAndFix(makeOpts({ agent, getCiStatus, collectFailureLogs }));

    expect(collectFailureLogs).toHaveBeenCalledWith(
      "org",
      "repo",
      expect.objectContaining({ databaseId: 300 }),
    );
  });

  // -- check run failure triggers fix -----------------------------------------

  test("collects logs from failed check runs with source check", async () => {
    const runs = [
      makeCiRun({
        databaseId: 500,
        name: "CodeQL",
        conclusion: "failure",
        source: "check",
      }),
    ];
    const getCiStatus = vi
      .fn()
      .mockReturnValueOnce(makeCiStatus("fail", runs))
      .mockReturnValueOnce(makeCiStatus("pass"));
    const collectFailureLogs = vi
      .fn()
      .mockReturnValue("CodeQL: SQL injection found");

    const agent = makeAgent();
    await pollCiAndFix(makeOpts({ agent, getCiStatus, collectFailureLogs }));

    expect(collectFailureLogs).toHaveBeenCalledWith(
      "org",
      "repo",
      expect.objectContaining({ databaseId: 500, source: "check" }),
    );
    const invokedPrompt = (agent.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(invokedPrompt).toContain("CodeQL: SQL injection found");
  });

  // -- fix attempt 1 fails, attempt 2 succeeds -------------------------------

  test("retries CI fix when first fix does not resolve failure", async () => {
    const getCiStatus = vi
      .fn()
      .mockReturnValueOnce(
        makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]),
      )
      .mockReturnValueOnce(
        makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]),
      )
      .mockReturnValueOnce(makeCiStatus("pass"));

    const collectFailureLogs = vi.fn().mockReturnValue("err");

    const invokeResults = [
      makeStream(makeResult({ responseText: "Fix 1." })),
      makeStream(makeResult({ responseText: "Fix 2." })),
    ];
    let call = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => invokeResults[call++]),
      resume: vi.fn(),
    };

    const result = await pollCiAndFix(
      makeOpts({ agent, getCiStatus, collectFailureLogs }),
    );

    expect(result.passed).toBe(true);
    expect(agent.invoke).toHaveBeenCalledTimes(2);
  });

  // -- maxFixAttempts = 0 means no fix attempts -------------------------------

  test("returns error immediately with maxFixAttempts=0 on CI failure", async () => {
    const getCiStatus = vi
      .fn()
      .mockReturnValue(
        makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]),
      );

    const agent = makeAgent();
    const result = await pollCiAndFix(
      makeOpts({ agent, getCiStatus, maxFixAttempts: 0 }),
    );

    expect(result.passed).toBe(false);
    expect(result.message).toContain("still failing after 0 fix attempt");
    expect(agent.invoke).not.toHaveBeenCalled();
  });

  // -- getHeadSha integration ---------------------------------------------------

  test("reads HEAD SHA from worktree and forwards to getCiStatus", async () => {
    const getCiStatus = vi.fn().mockReturnValue(makeCiStatus("pass"));
    const getHeadSha = vi.fn().mockReturnValue("deadbeef");
    const opts = makeOpts({ getCiStatus, getHeadSha });
    await pollCiAndFix(opts);

    expect(getHeadSha).toHaveBeenCalledWith("/tmp/wt");
    expect(getCiStatus).toHaveBeenCalledWith(
      "org",
      "repo",
      "issue-42",
      "deadbeef",
    );
  });

  test("waits within grace period when SHA filter returns empty pass", async () => {
    // No workflow yet → getCiStatus returns pass with empty runs.
    // Grace period keeps polling; eventually runs appear and pass.
    const getHeadSha = vi.fn().mockReturnValue("new-sha");
    const getCiStatus = vi
      .fn()
      .mockReturnValueOnce(makeCiStatus("pass")) // empty, within grace
      .mockReturnValueOnce(makeCiStatus("pass")) // empty, within grace
      .mockReturnValueOnce(makeCiStatus("pass", [makeCiRun()])); // runs appeared

    let elapsed = 0;
    const startTime = Date.now();
    const delay = vi.fn().mockImplementation(async () => {
      elapsed += 100;
    });
    vi.spyOn(Date, "now").mockImplementation(() => startTime + elapsed);

    const result = await pollCiAndFix(
      makeOpts({
        getCiStatus,
        getHeadSha,
        delay,
        emptyRunsGracePeriodMs: 500,
      }),
    );

    expect(result.passed).toBe(true);
    expect(getCiStatus).toHaveBeenCalledTimes(3);

    vi.restoreAllMocks();
  });

  test("accepts empty pass after grace period expires", async () => {
    // No CI configured → empty runs persist beyond grace period.
    const getHeadSha = vi.fn().mockReturnValue("new-sha");
    const getCiStatus = vi.fn().mockReturnValue(makeCiStatus("pass")); // always empty

    let elapsed = 0;
    const startTime = Date.now();
    const delay = vi.fn().mockImplementation(async () => {
      elapsed += 300;
    });
    vi.spyOn(Date, "now").mockImplementation(() => startTime + elapsed);

    const result = await pollCiAndFix(
      makeOpts({
        getCiStatus,
        getHeadSha,
        delay,
        emptyRunsGracePeriodMs: 500,
        pollIntervalMs: 100,
      }),
    );

    expect(result.passed).toBe(true);
    expect(result.message).toContain("CI checks passed");

    vi.restoreAllMocks();
  });

  test("re-reads HEAD SHA after each fix push", async () => {
    let shaCall = 0;
    const shas = ["aaa111", "bbb222"];
    const getHeadSha = vi.fn().mockImplementation(() => shas[shaCall++]);

    const getCiStatus = vi
      .fn()
      .mockReturnValueOnce(
        makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]),
      )
      .mockReturnValueOnce(makeCiStatus("pass"));
    const collectFailureLogs = vi.fn().mockReturnValue("err");

    const agent = makeAgent();
    await pollCiAndFix(
      makeOpts({ agent, getCiStatus, collectFailureLogs, getHeadSha }),
    );

    expect(getHeadSha).toHaveBeenCalledTimes(2);
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

  // -- transient getCiStatus error retried ------------------------------------

  test("retries on transient getCiStatus error then succeeds", async () => {
    const getCiStatus = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("502 Bad Gateway");
      })
      .mockReturnValueOnce(makeCiStatus("pass"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const delay = vi.fn().mockResolvedValue(undefined);

    const result = await pollCiAndFix(makeOpts({ getCiStatus, delay }));

    expect(result.passed).toBe(true);
    expect(getCiStatus).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("502 Bad Gateway");

    warnSpy.mockRestore();
  });

  test("returns timeout when getCiStatus keeps failing", async () => {
    const getCiStatus = vi.fn().mockImplementation(() => {
      throw new Error("persistent failure");
    });

    let elapsed = 0;
    const startTime = Date.now();
    const delay = vi.fn().mockImplementation(async () => {
      elapsed += 500;
    });
    vi.spyOn(Date, "now").mockImplementation(() => startTime + elapsed);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await pollCiAndFix(
      makeOpts({
        getCiStatus,
        delay,
        pollIntervalMs: 100,
        pollTimeoutMs: 1000,
      }),
    );

    expect(result.passed).toBe(false);
    expect(result.message).toContain("still pending");
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    vi.restoreAllMocks();
  });

  // -- timeout during fix loop (pending after agent pushes fix) ---------------

  test("returns timeout error when CI stays pending during fix loop", async () => {
    // First poll: fail. After fix: pending until timeout.
    let pollCount = 0;
    const getCiStatus = vi.fn().mockImplementation(() => {
      pollCount++;
      if (pollCount === 1) {
        return makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]);
      }
      return makeCiStatus("pending");
    });

    let elapsed = 0;
    const startTime = Date.now();
    const delay = vi.fn().mockImplementation(async () => {
      elapsed += 600;
    });
    vi.spyOn(Date, "now").mockImplementation(() => startTime + elapsed);

    const collectFailureLogs = vi.fn().mockReturnValue("err");
    const agent = makeAgent();
    const result = await pollCiAndFix(
      makeOpts({
        agent,
        getCiStatus,
        collectFailureLogs,
        delay,
        pollIntervalMs: 100,
        pollTimeoutMs: 1000,
      }),
    );

    expect(result.passed).toBe(false);
    expect(result.message).toContain("still pending");

    vi.restoreAllMocks();
  });

  // -- CI passes with findings — agent reviews --------------------------------

  test("presents findings to agent and returns passed when agent acknowledges", async () => {
    const findings: CiFinding[] = [
      {
        level: "warning",
        message: "Unused variable",
        file: "src/app.ts",
        line: 10,
        rule: "no-unused-vars",
        checkRunId: 500,
        checkRunName: "ESLint",
        commitSha: "abc123",
      },
    ];
    const getCiStatus = vi
      .fn()
      .mockReturnValue(makeCiStatus("pass", [makeCiRun()], findings));
    const getHeadSha = vi.fn().mockReturnValue("same-sha");

    const agent = makeAgent();
    const result = await pollCiAndFix(
      makeOpts({ agent, getCiStatus, getHeadSha }),
    );

    expect(result.passed).toBe(true);
    expect(result.message).toContain("Findings were reviewed");
    expect(agent.invoke).toHaveBeenCalledWith(
      expect.stringContaining("CI Findings"),
      expect.any(Object),
    );
  });

  test("re-polls CI when agent pushes a fix for findings", async () => {
    const findings: CiFinding[] = [
      {
        level: "warning",
        message: "Unused import",
        file: "src/index.ts",
        line: 1,
        checkRunId: 600,
        checkRunName: "Lint",
        commitSha: "abc123",
      },
    ];

    // First poll: pass with findings. After agent fix: pass clean.
    const getCiStatus = vi
      .fn()
      .mockReturnValueOnce(makeCiStatus("pass", [makeCiRun()], findings))
      .mockReturnValueOnce(makeCiStatus("pass", [makeCiRun()]));

    // SHA sequence: top-of-loop, shaBeforeReview, shaAfterReview (changed),
    // top-of-loop again for second poll.
    let shaCall = 0;
    const shas = ["sha-1", "sha-1", "sha-2", "sha-2"];
    const getHeadSha = vi.fn().mockImplementation(() => shas[shaCall++]);

    const agent = makeAgent();
    const result = await pollCiAndFix(
      makeOpts({ agent, getCiStatus, getHeadSha }),
    );

    expect(result.passed).toBe(true);
    expect(result.message).toContain("CI checks passed");
    expect(agent.invoke).toHaveBeenCalledTimes(1);
    // CI was polled twice: first with findings, then clean after fix.
    expect(getCiStatus).toHaveBeenCalledTimes(2);
  });

  test("returns error when agent fails during findings review", async () => {
    const findings: CiFinding[] = [
      {
        level: "warning",
        message: "Unused variable",
        file: "src/app.ts",
        line: 10,
        checkRunId: 500,
        checkRunName: "ESLint",
        commitSha: "abc123",
      },
    ];
    const getCiStatus = vi
      .fn()
      .mockReturnValue(makeCiStatus("pass", [makeCiRun()], findings));
    const getHeadSha = vi.fn().mockReturnValue("sha");

    const agent = makeAgent(
      makeResult({
        status: "error",
        errorType: "execution_error",
        stderrText: "crash",
        responseText: "",
      }),
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await pollCiAndFix(
      makeOpts({ agent, getCiStatus, getHeadSha }),
    );

    expect(result.passed).toBe(false);
    expect(result.message).toContain("Agent error during CI fix");

    errorSpy.mockRestore();
  });

  test("routes to findings review when findingsIncomplete even with no findings", async () => {
    const getCiStatus = vi
      .fn()
      .mockReturnValueOnce(makeCiStatus("pass", [makeCiRun()], [], true))
      .mockReturnValueOnce(makeCiStatus("pass", [makeCiRun()]));

    // SHA sequence: top-of-loop, shaBeforeReview, shaAfterReview (unchanged).
    const getHeadSha = vi.fn().mockReturnValue("same-sha");

    const agent = makeAgent();
    const result = await pollCiAndFix(
      makeOpts({ agent, getCiStatus, getHeadSha }),
    );

    // Agent was invoked with the findings prompt (not the clean-pass exit).
    expect(agent.invoke).toHaveBeenCalledWith(
      expect.stringContaining("CI Findings"),
      expect.any(Object),
    );
    const invokedPrompt = (agent.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(invokedPrompt).toContain("annotations could not be fetched");

    // SHA unchanged → findings acknowledged.
    expect(result.passed).toBe(true);
    expect(result.message).toContain("Findings were reviewed");
  });

  // -- findings-review counter is decoupled from fix-attempt counter --------

  test("maxFixAttempts=0 still allows findings review", async () => {
    const findings: CiFinding[] = [
      {
        level: "warning",
        message: "Unused variable",
        file: "src/app.ts",
        line: 10,
        checkRunId: 500,
        checkRunName: "ESLint",
        commitSha: "abc123",
      },
    ];
    const getCiStatus = vi
      .fn()
      .mockReturnValue(makeCiStatus("pass", [makeCiRun()], findings));
    const getHeadSha = vi.fn().mockReturnValue("same-sha");

    const agent = makeAgent();
    const result = await pollCiAndFix(
      makeOpts({ agent, getCiStatus, getHeadSha, maxFixAttempts: 0 }),
    );

    expect(result.passed).toBe(true);
    expect(result.message).toContain("Findings were reviewed");
    expect(agent.invoke).toHaveBeenCalledTimes(1);
  });

  test("maxFixAttempts=0 re-polls after findings-driven push", async () => {
    const findings: CiFinding[] = [
      {
        level: "warning",
        message: "Unused import",
        file: "src/index.ts",
        line: 1,
        checkRunId: 600,
        checkRunName: "Lint",
        commitSha: "abc123",
      },
    ];
    // First poll: pass with findings. After agent fix: pass clean.
    const getCiStatus = vi
      .fn()
      .mockReturnValueOnce(makeCiStatus("pass", [makeCiRun()], findings))
      .mockReturnValueOnce(makeCiStatus("pass", [makeCiRun()]));

    let shaCall = 0;
    const shas = ["sha-1", "sha-1", "sha-2", "sha-2"];
    const getHeadSha = vi.fn().mockImplementation(() => shas[shaCall++]);

    const agent = makeAgent();
    const result = await pollCiAndFix(
      makeOpts({ agent, getCiStatus, getHeadSha, maxFixAttempts: 0 }),
    );

    // Should pass cleanly — not hit fixLoopExhausted.
    expect(result.passed).toBe(true);
    expect(result.message).toContain("CI checks passed");
    expect(agent.invoke).toHaveBeenCalledTimes(1);
  });

  test("findings reviews do not consume failure-fix budget", async () => {
    const findings: CiFinding[] = [
      {
        level: "warning",
        message: "Unused variable",
        file: "src/app.ts",
        line: 10,
        checkRunId: 500,
        checkRunName: "ESLint",
        commitSha: "abc123",
      },
    ];

    // Sequence: pass with findings → agent pushes →
    // CI fails → agent fixes → CI passes.
    const getCiStatus = vi
      .fn()
      .mockReturnValueOnce(makeCiStatus("pass", [makeCiRun()], findings))
      .mockReturnValueOnce(
        makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]),
      )
      .mockReturnValueOnce(makeCiStatus("pass", [makeCiRun()]));
    const collectFailureLogs = vi.fn().mockReturnValue("err");

    // SHA sequence: top-of-loop (sha-1), shaBeforeReview (sha-1),
    // shaAfterReview (sha-2, agent pushed), top-of-loop (sha-2),
    // top-of-loop after fix (sha-3).
    let shaCall = 0;
    const shas = ["sha-1", "sha-1", "sha-2", "sha-2", "sha-3"];
    const getHeadSha = vi.fn().mockImplementation(() => shas[shaCall++]);

    const invokeResults = [
      makeStream(makeResult({ responseText: "Reviewed findings." })),
      makeStream(makeResult({ responseText: "Fixed CI." })),
    ];
    let invokeCall = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => invokeResults[invokeCall++]),
      resume: vi.fn(),
    };

    const result = await pollCiAndFix(
      makeOpts({
        agent,
        getCiStatus,
        collectFailureLogs,
        getHeadSha,
        maxFixAttempts: 1,
      }),
    );

    // Should succeed: findings review (1 review) + CI failure fix (1 fix).
    // With the old coupled counter, this would have exhausted the budget.
    expect(result.passed).toBe(true);
    expect(result.message).toContain("CI checks passed");
    expect(agent.invoke).toHaveBeenCalledTimes(2);
  });

  test("caps findings-review re-polls at maxFixAttempts", async () => {
    const findings: CiFinding[] = [
      {
        level: "warning",
        message: "Unused variable",
        file: "src/app.ts",
        line: 10,
        checkRunId: 500,
        checkRunName: "ESLint",
        commitSha: "abc123",
      },
    ];

    // Agent keeps pushing but findings persist.
    const getCiStatus = vi
      .fn()
      .mockReturnValue(makeCiStatus("pass", [makeCiRun()], findings));

    // SHA changes after every review to simulate agent pushing.
    let shaCounter = 0;
    const getHeadSha = vi.fn().mockImplementation(() => {
      const sha = `sha-${Math.floor(shaCounter / 2)}`;
      shaCounter++;
      return sha;
    });

    const invokeResults = [
      makeStream(makeResult()),
      makeStream(makeResult()),
      makeStream(makeResult()),
    ];
    let invokeCall = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => invokeResults[invokeCall++]),
      resume: vi.fn(),
    };

    const result = await pollCiAndFix(
      makeOpts({
        agent,
        getCiStatus,
        getHeadSha,
        maxFixAttempts: 2,
      }),
    );

    // Should return passedWithFindings after exhausting the review budget,
    // not ci.stillFailing or ci.fixLoopExhausted.
    expect(result.passed).toBe(true);
    expect(result.message).toContain("Findings were reviewed");
    // maxFixAttempts=2 → max(1,2)=2 findings reviews allowed.
    expect(agent.invoke).toHaveBeenCalledTimes(2);
  });

  test("findings prompt includes structured finding details", async () => {
    const findings: CiFinding[] = [
      {
        level: "warning",
        message: "Unused variable 'x'",
        file: "src/app.ts",
        line: 10,
        rule: "no-unused-vars",
        checkRunId: 500,
        checkRunName: "ESLint",
        commitSha: "abc123",
      },
    ];
    const getCiStatus = vi
      .fn()
      .mockReturnValue(makeCiStatus("pass", [makeCiRun()], findings));
    const getHeadSha = vi.fn().mockReturnValue("same-sha");

    const agent = makeAgent();
    await pollCiAndFix(makeOpts({ agent, getCiStatus, getHeadSha }));

    const invokedPrompt = (agent.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(invokedPrompt).toContain("Unused variable 'x'");
    expect(invokedPrompt).toContain("src/app.ts:10");
    expect(invokedPrompt).toContain("no-unused-vars");
    expect(invokedPrompt).toContain("ESLint (check run 500)");
  });

  // -- triage: code scanning alert correlation --------------------------------

  test("fetches code scanning alerts when CI passes with findings", async () => {
    const findings: CiFinding[] = [
      {
        level: "warning",
        message: "SQL injection",
        file: "src/db.ts",
        line: 42,
        rule: "js/sql-injection",
        checkRunId: 500,
        checkRunName: "CodeQL",
        commitSha: "abc123",
      },
    ];
    const getCiStatus = vi
      .fn()
      .mockReturnValue(makeCiStatus("pass", [makeCiRun()], findings));
    const getHeadSha = vi.fn().mockReturnValue("same-sha");
    const fetchCodeScanningAlerts = vi.fn().mockReturnValue([]);

    const agent = makeAgent();
    await pollCiAndFix(
      makeOpts({ agent, getCiStatus, getHeadSha, fetchCodeScanningAlerts }),
    );

    expect(fetchCodeScanningAlerts).toHaveBeenCalledWith(
      "org",
      "repo",
      "issue-42",
    );
  });

  test("includes triage instructions when alerts are correlated", async () => {
    const findings: CiFinding[] = [
      {
        level: "warning",
        message: "SQL injection",
        file: "src/db.ts",
        line: 42,
        rule: "js/sql-injection",
        checkRunId: 500,
        checkRunName: "CodeQL",
        commitSha: "abc123",
      },
    ];
    const getCiStatus = vi
      .fn()
      .mockReturnValue(makeCiStatus("pass", [makeCiRun()], findings));
    const getHeadSha = vi.fn().mockReturnValue("same-sha");
    const fetchCodeScanningAlerts = vi.fn().mockReturnValue([
      {
        number: 10,
        rule: { id: "js/sql-injection" },
        tool: { name: "CodeQL" },
        most_recent_instance: {
          location: { path: "src/db.ts", start_line: 42 },
          commit_sha: "abc123",
        },
        state: "open",
        html_url: "https://github.com/org/repo/security/code-scanning/10",
      },
    ]);

    const agent = makeAgent();
    await pollCiAndFix(
      makeOpts({ agent, getCiStatus, getHeadSha, fetchCodeScanningAlerts }),
    );

    const invokedPrompt = (agent.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(invokedPrompt).toContain("CodeQL Triage");
    expect(invokedPrompt).toContain("Alert #10");
    expect(invokedPrompt).toContain("[alert #10]");
  });

  test("does not fetch alerts on clean pass", async () => {
    const getCiStatus = vi
      .fn()
      .mockReturnValue(makeCiStatus("pass", [makeCiRun()]));
    const fetchCodeScanningAlerts = vi.fn().mockReturnValue([]);

    await pollCiAndFix(makeOpts({ getCiStatus, fetchCodeScanningAlerts }));

    expect(fetchCodeScanningAlerts).not.toHaveBeenCalled();
  });

  test("does not fetch alerts on CI failure", async () => {
    const getCiStatus = vi
      .fn()
      .mockReturnValueOnce(
        makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]),
      )
      .mockReturnValueOnce(makeCiStatus("pass"));
    const collectFailureLogs = vi.fn().mockReturnValue("err");
    const fetchCodeScanningAlerts = vi.fn().mockReturnValue([]);

    const agent = makeAgent();
    await pollCiAndFix(
      makeOpts({
        agent,
        getCiStatus,
        collectFailureLogs,
        fetchCodeScanningAlerts,
      }),
    );

    // fetchCodeScanningAlerts should not be called during the failure fix
    // phase — only during findings review.
    expect(fetchCodeScanningAlerts).not.toHaveBeenCalled();
  });

  // -- pipeline:ci-poll event emission ----------------------------------------

  test("emits start, status, done events on clean pass", async () => {
    const events = new PipelineEventEmitter();
    const collected: PipelineCiPollEvent[] = [];
    events.on("pipeline:ci-poll", (e) => collected.push(e));

    await pollCiAndFix(makeOpts({ events }));

    expect(collected).toEqual([
      { action: "start", sha: "abc123" },
      { action: "status", sha: "abc123", verdict: "pass" },
      { action: "done", sha: "abc123", verdict: "pass" },
    ]);
  });

  test("emits done with pending verdict on timeout", async () => {
    const events = new PipelineEventEmitter();
    const collected: PipelineCiPollEvent[] = [];
    events.on("pipeline:ci-poll", (e) => collected.push(e));

    const getCiStatus = vi.fn().mockReturnValue(makeCiStatus("pending"));
    let elapsed = 0;
    const startTime = Date.now();
    const delay = vi.fn().mockImplementation(async () => {
      elapsed += 500;
    });
    vi.spyOn(Date, "now").mockImplementation(() => startTime + elapsed);

    await pollCiAndFix(
      makeOpts({
        events,
        getCiStatus,
        delay,
        pollIntervalMs: 100,
        pollTimeoutMs: 1000,
      }),
    );

    expect(collected[0]).toEqual({ action: "start", sha: "abc123" });
    const done = collected[collected.length - 1];
    expect(done.action).toBe("done");
    expect(done.verdict).toBe("pending");

    vi.restoreAllMocks();
  });

  test("emits events across fix loop", async () => {
    const events = new PipelineEventEmitter();
    const collected: PipelineCiPollEvent[] = [];
    events.on("pipeline:ci-poll", (e) => collected.push(e));

    const getCiStatus = vi
      .fn()
      .mockReturnValueOnce(
        makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]),
      )
      .mockReturnValueOnce(makeCiStatus("pass"));
    const collectFailureLogs = vi.fn().mockReturnValue("err");
    const agent = makeAgent();

    await pollCiAndFix(
      makeOpts({ events, agent, getCiStatus, collectFailureLogs }),
    );

    // Each polling round gets start → status → done, even when
    // transitioning into a fix loop.
    const actions = collected.map((e) => e.action);
    expect(actions).toEqual([
      "start",
      "status",
      "done",
      "start",
      "status",
      "done",
    ]);
    expect(collected[1].verdict).toBe("fail");
    expect(collected[2]).toEqual({
      action: "done",
      sha: "abc123",
      verdict: "fail",
    });
    expect(collected[5].verdict).toBe("pass");
  });

  test("emits done on fix attempts exhausted", async () => {
    const events = new PipelineEventEmitter();
    const collected: PipelineCiPollEvent[] = [];
    events.on("pipeline:ci-poll", (e) => collected.push(e));

    const getCiStatus = vi
      .fn()
      .mockReturnValue(
        makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]),
      );
    const collectFailureLogs = vi.fn().mockReturnValue("err");

    const invokeResults = [makeStream(makeResult())];
    let call = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => invokeResults[call++]),
      resume: vi.fn(),
    };

    await pollCiAndFix(
      makeOpts({
        events,
        agent,
        getCiStatus,
        collectFailureLogs,
        maxFixAttempts: 1,
      }),
    );

    const done = collected[collected.length - 1];
    expect(done.action).toBe("done");
    expect(done.verdict).toBe("fail");
  });

  test("emits done on agent error during CI fix", async () => {
    const events = new PipelineEventEmitter();
    const collected: PipelineCiPollEvent[] = [];
    events.on("pipeline:ci-poll", (e) => collected.push(e));

    const getCiStatus = vi
      .fn()
      .mockReturnValue(
        makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]),
      );
    const collectFailureLogs = vi.fn().mockReturnValue("err");
    const agent = makeAgent(
      makeResult({
        status: "error",
        errorType: "execution_error",
        stderrText: "crash",
        responseText: "",
      }),
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await pollCiAndFix(
      makeOpts({ events, agent, getCiStatus, collectFailureLogs }),
    );

    const done = collected[collected.length - 1];
    expect(done.action).toBe("done");
    expect(done.verdict).toBe("fail");

    errorSpy.mockRestore();
  });

  test("emits done on agent error during findings review", async () => {
    const events = new PipelineEventEmitter();
    const collected: PipelineCiPollEvent[] = [];
    events.on("pipeline:ci-poll", (e) => collected.push(e));

    const findings: CiFinding[] = [
      {
        level: "warning",
        message: "Unused variable",
        file: "src/app.ts",
        line: 10,
        checkRunId: 500,
        checkRunName: "ESLint",
        commitSha: "abc123",
      },
    ];
    const getCiStatus = vi
      .fn()
      .mockReturnValue(makeCiStatus("pass", [makeCiRun()], findings));
    const agent = makeAgent(
      makeResult({
        status: "error",
        errorType: "execution_error",
        stderrText: "crash",
        responseText: "",
      }),
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await pollCiAndFix(makeOpts({ events, agent, getCiStatus }));

    const done = collected[collected.length - 1];
    expect(done.action).toBe("done");
    expect(done.verdict).toBe("pass");

    errorSpy.mockRestore();
  });

  test("falls back to ctx.events when options.events is not provided", async () => {
    const events = new PipelineEventEmitter();
    const collected: PipelineCiPollEvent[] = [];
    events.on("pipeline:ci-poll", (e) => collected.push(e));

    const ctxWithEvents: StageContext = { ...BASE_CTX, events };

    await pollCiAndFix(makeOpts({ ctx: ctxWithEvents }));

    expect(collected).toEqual([
      { action: "start", sha: "abc123" },
      { action: "status", sha: "abc123", verdict: "pass" },
      { action: "done", sha: "abc123", verdict: "pass" },
    ]);
  });
});
