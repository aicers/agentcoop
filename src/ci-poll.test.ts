import { describe, expect, test, vi } from "vitest";
import type { AgentAdapter, AgentResult, AgentStream } from "./agent.js";
import type { CiRun, CiStatus, CiVerdict } from "./ci.js";
import { type CiPollOptions, pollCiAndFix } from "./ci-poll.js";
import type { StageContext } from "./pipeline.js";

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
    expect(collectFailureLogs).toHaveBeenCalledWith("org", "repo", 200);
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
    expect(collectFailureLogs).toHaveBeenCalledWith("org", "repo", 200);
    expect(collectFailureLogs).toHaveBeenCalledWith("org", "repo", 201);

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

    expect(collectFailureLogs).toHaveBeenCalledWith("org", "repo", 300);
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
});
