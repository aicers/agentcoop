import { describe, expect, test, vi } from "vitest";
import type { AgentAdapter, AgentResult, AgentStream } from "./agent.js";
import type { CiRun, CiStatus, CiVerdict } from "./ci.js";
import type { StageContext } from "./pipeline.js";
import {
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
    collectFailureLogs: vi.fn().mockReturnValue(""),
    getHeadSha: vi.fn().mockReturnValue("abc123"),
    delay: vi.fn().mockResolvedValue(undefined),
    pollIntervalMs: 100,
    pollTimeoutMs: 1000,
    emptyRunsGracePeriodMs: 0,
    ...overrides,
  };
}

// ---- buildCiFixPrompt ------------------------------------------------------

describe("buildCiFixPrompt", () => {
  test("includes repo context", () => {
    const prompt = buildCiFixPrompt(BASE_CTX, makeOpts(), "error log");
    expect(prompt).toContain("Owner: org");
    expect(prompt).toContain("Repo: repo");
    expect(prompt).toContain("Branch: issue-42");
    expect(prompt).toContain("Worktree: /tmp/wt");
  });

  test("includes issue details", () => {
    const prompt = buildCiFixPrompt(BASE_CTX, makeOpts(), "error log");
    expect(prompt).toContain("Issue #42: Fix the widget");
    expect(prompt).toContain("The widget is broken.");
  });

  test("includes failure logs", () => {
    const prompt = buildCiFixPrompt(BASE_CTX, makeOpts(), "npm test failed");
    expect(prompt).toContain("CI Failure Logs");
    expect(prompt).toContain("npm test failed");
  });

  test("handles empty failure logs", () => {
    const prompt = buildCiFixPrompt(BASE_CTX, makeOpts(), "");
    expect(prompt).toContain("No detailed failure logs available");
  });

  test("instructs to commit and push", () => {
    const prompt = buildCiFixPrompt(BASE_CTX, makeOpts(), "error");
    expect(prompt).toContain("commit and push");
  });

  test("includes doc consistency instructions", () => {
    const prompt = buildCiFixPrompt(BASE_CTX, makeOpts(), "error");
    expect(prompt).toContain("CHANGELOG");
    expect(prompt).toContain("MkDocs");
  });

  test("includes user instruction when present", () => {
    const ctx = { ...BASE_CTX, userInstruction: "Ignore lint warnings" };
    const prompt = buildCiFixPrompt(ctx, makeOpts(), "error");
    expect(prompt).toContain("Additional feedback");
    expect(prompt).toContain("Ignore lint warnings");
  });

  test("omits feedback section when no instruction", () => {
    const prompt = buildCiFixPrompt(BASE_CTX, makeOpts(), "error");
    expect(prompt).not.toContain("Additional feedback");
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
    // Simulate time passing by advancing Date.now on each delay call.
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

  test("collects failure logs and invokes agent on CI failure", async () => {
    const failedRun = makeCiRun({
      databaseId: 200,
      name: "test-suite",
      conclusion: "failure",
    });
    const getCiStatus = vi
      .fn()
      .mockReturnValue(makeCiStatus("fail", [failedRun]));
    const collectFailureLogs = vi
      .fn()
      .mockReturnValue("Error: test failed at line 42");

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(makeResult())),
      resume: vi.fn().mockReturnValue(makeStream(makeResult())),
    };

    const opts = makeOpts({ agent, getCiStatus, collectFailureLogs });
    const stage = createCiCheckStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(collectFailureLogs).toHaveBeenCalledWith(
      "org",
      "repo",
      expect.objectContaining({ databaseId: 200 }),
    );
    expect(agent.invoke).toHaveBeenCalledWith(
      expect.stringContaining("CI Failure Logs"),
      { cwd: "/tmp/wt" },
    );
    expect(result.outcome).toBe("not_approved");
  });

  test("fix prompt includes failure log content", async () => {
    const failedRun = makeCiRun({
      databaseId: 300,
      name: "lint",
      conclusion: "failure",
    });
    const getCiStatus = vi
      .fn()
      .mockReturnValue(makeCiStatus("fail", [failedRun]));
    const collectFailureLogs = vi
      .fn()
      .mockReturnValue("lint error: unused variable");

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(makeResult())),
      resume: vi.fn().mockReturnValue(makeStream(makeResult())),
    };

    const opts = makeOpts({ agent, getCiStatus, collectFailureLogs });
    const stage = createCiCheckStageHandler(opts);
    await stage.handler(BASE_CTX);

    const invokedPrompt = (agent.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(invokedPrompt).toContain("lint error: unused variable");
  });

  test("returns not_approved after agent fix to trigger engine loop", async () => {
    const getCiStatus = vi
      .fn()
      .mockReturnValue(
        makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]),
      );
    const collectFailureLogs = vi.fn().mockReturnValue("error log");

    const opts = makeOpts({ getCiStatus, collectFailureLogs });
    const stage = createCiCheckStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("not_approved");
  });

  test("includes user instruction in fix prompt when present", async () => {
    const failedRun = makeCiRun({ conclusion: "failure" });
    const getCiStatus = vi
      .fn()
      .mockReturnValue(makeCiStatus("fail", [failedRun]));
    const collectFailureLogs = vi.fn().mockReturnValue("error");

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(makeResult())),
      resume: vi.fn().mockReturnValue(makeStream(makeResult())),
    };

    const ctx = { ...BASE_CTX, userInstruction: "Skip the flaky e2e test" };
    const opts = makeOpts({ agent, getCiStatus, collectFailureLogs });
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
    const collectFailureLogs = vi.fn().mockReturnValue("error");

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

    const opts = makeOpts({ agent, getCiStatus, collectFailureLogs });
    const stage = createCiCheckStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("crash");
    expect(result.message).toContain("CI fix");
  });

  test("handles no detailed logs gracefully", async () => {
    const failedRun = makeCiRun({ conclusion: "failure" });
    const getCiStatus = vi
      .fn()
      .mockReturnValue(makeCiStatus("fail", [failedRun]));
    const collectFailureLogs = vi.fn().mockReturnValue("");

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(makeResult())),
      resume: vi.fn().mockReturnValue(makeStream(makeResult())),
    };

    const opts = makeOpts({ agent, getCiStatus, collectFailureLogs });
    const stage = createCiCheckStageHandler(opts);
    await stage.handler(BASE_CTX);

    const invokedPrompt = (agent.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(invokedPrompt).toContain("No detailed failure logs available");
  });

  test("collects logs from multiple failed runs", async () => {
    const runs = [
      makeCiRun({ databaseId: 200, name: "lint", conclusion: "failure" }),
      makeCiRun({ databaseId: 201, name: "test", conclusion: "failure" }),
      makeCiRun({ databaseId: 202, name: "build", conclusion: "success" }),
    ];
    const getCiStatus = vi.fn().mockReturnValue(makeCiStatus("fail", runs));
    const collectFailureLogs = vi
      .fn()
      .mockReturnValueOnce("lint: unused var")
      .mockReturnValueOnce("test: assertion failed");

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(makeResult())),
      resume: vi.fn(),
    };

    const opts = makeOpts({ agent, getCiStatus, collectFailureLogs });
    const stage = createCiCheckStageHandler(opts);
    await stage.handler(BASE_CTX);

    // Should collect from the two failed runs only
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

  test("handles fail verdict with no matching failed runs gracefully", async () => {
    // Cancelled runs: verdict is "fail" but conclusion is "cancelled"
    const runs = [makeCiRun({ conclusion: "cancelled" })];
    const getCiStatus = vi.fn().mockReturnValue(makeCiStatus("fail", runs));
    const collectFailureLogs = vi.fn().mockReturnValue("");

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(makeResult())),
      resume: vi.fn(),
    };

    const opts = makeOpts({ agent, getCiStatus, collectFailureLogs });
    const stage = createCiCheckStageHandler(opts);
    await stage.handler(BASE_CTX);

    const invokedPrompt = (agent.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(invokedPrompt).toContain("No detailed failure logs available");
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

  test("propagates collectFailureLogs exception as thrown error", async () => {
    const getCiStatus = vi
      .fn()
      .mockReturnValue(
        makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]),
      );
    const collectFailureLogs = vi.fn().mockImplementation(() => {
      throw new Error("gh CLI failed");
    });

    const opts = makeOpts({ getCiStatus, collectFailureLogs });
    const stage = createCiCheckStageHandler(opts);

    await expect(stage.handler(BASE_CTX)).rejects.toThrow("gh CLI failed");
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
    const collectFailureLogs = vi.fn().mockReturnValue("err");
    const fixResponse = "Fixed the linting issue and pushed.";

    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: fixResponse }))),
      resume: vi.fn(),
    };

    const opts = makeOpts({ agent, getCiStatus, collectFailureLogs });
    const stage = createCiCheckStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.message).toBe(fixResponse);
  });
});
