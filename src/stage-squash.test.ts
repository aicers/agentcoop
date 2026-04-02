import { describe, expect, test, vi } from "vitest";
import type { AgentAdapter, AgentResult, AgentStream } from "./agent.js";
import type { CiRun, CiStatus, CiVerdict } from "./ci.js";
import type { StageContext } from "./pipeline.js";
import {
  buildSquashCompletionCheckPrompt,
  buildSquashPrompt,
  createSquashStageHandler,
  type SquashStageOptions,
} from "./stage-squash.js";

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

function makeCiRun(overrides: Partial<CiRun> = {}): CiRun {
  return {
    databaseId: 100,
    name: "build",
    status: "completed",
    conclusion: "success",
    headBranch: "issue-42",
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
      .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
  };

  return {
    agent,
    issueTitle: "Fix the widget",
    issueBody: "The widget is broken.",
    getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
    collectFailureLogs: vi.fn().mockReturnValue(""),
    delay: vi.fn().mockResolvedValue(undefined),
    pollIntervalMs: 100,
    pollTimeoutMs: 1000,
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

  test("includes squash instructions", () => {
    const prompt = buildSquashPrompt(BASE_CTX, makeOpts());
    expect(prompt).toContain("Squash all commits");
    expect(prompt).toContain("Force-push the branch");
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
});

// ---- buildSquashCompletionCheckPrompt ----------------------------------------

describe("buildSquashCompletionCheckPrompt", () => {
  test("mentions COMPLETED and BLOCKED keywords", () => {
    const prompt = buildSquashCompletionCheckPrompt();
    expect(prompt).toContain("COMPLETED");
    expect(prompt).toContain("BLOCKED");
  });
});

// ---- createSquashStageHandler ------------------------------------------------

describe("createSquashStageHandler", () => {
  test("returns stage definition with number 7 and correct name", () => {
    const stage = createSquashStageHandler(makeOpts());
    expect(stage.number).toBe(7);
    expect(stage.name).toBe("Squash commits");
    expect(stage.requiresArtifact).toBe(true);
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
            responseText: "Cannot squash.\n\nBLOCKED",
          }),
        ),
      ),
    };
    const opts = makeOpts({ agent });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("blocked");
    expect(result.message).toContain("Tried to squash");
    expect(result.message).toContain("Cannot squash");
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
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
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
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
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
      makeStream(makeResult({ responseText: "COMPLETED" })),
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
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };

    const opts = makeOpts({ agent, getCiStatus, collectFailureLogs });
    const stage = createSquashStageHandler(opts);
    await stage.handler(BASE_CTX);

    expect(collectFailureLogs).toHaveBeenCalledTimes(2);
    expect(collectFailureLogs).toHaveBeenCalledWith("org", "repo", 200);
    expect(collectFailureLogs).toHaveBeenCalledWith("org", "repo", 201);
  });

  // -- non-terminal non-blocked completion outcome ----------------------------

  test("returns needs_clarification when clarification also ambiguous", async () => {
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

    const opts = makeOpts({ agent });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("needs_clarification");
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
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };

    const opts = makeOpts({ agent, getCiStatus, collectFailureLogs });
    const stage = createSquashStageHandler(opts);
    const result = await stage.handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("agent crash");
  });
});
