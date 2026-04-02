/**
 * E2E tests for stages 2 and 3 running through the pipeline engine.
 *
 * These tests verify that the stage handlers integrate correctly with
 * pipeline loop control, blocked/error handling, and multi-stage flows.
 */

import { describe, expect, test, vi } from "vitest";
import type { AgentAdapter, AgentResult, AgentStream } from "./agent.js";
import type { CiRun, CiStatus, CiVerdict } from "./ci.js";
import type {
  PipelineOptions,
  StageContext,
  UserAction,
  UserPrompt,
} from "./pipeline.js";
import { runPipeline } from "./pipeline.js";
import { createCiCheckStageHandler } from "./stage-cicheck.js";
import { createCreatePrStageHandler } from "./stage-createpr.js";
import { createImplementStageHandler } from "./stage-implement.js";
import { createReviewStageHandler } from "./stage-review.js";
import { createSelfCheckStageHandler } from "./stage-selfcheck.js";
import { createSquashStageHandler } from "./stage-squash.js";
import { createTestPlanStageHandler } from "./stage-testplan.js";

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

function makePrompt(overrides: Partial<UserPrompt> = {}): UserPrompt {
  return {
    confirmContinueLoop: vi.fn().mockResolvedValue(true),
    confirmNextStage: vi.fn().mockResolvedValue(true),
    handleBlocked: vi
      .fn()
      .mockResolvedValue({ action: "halt" satisfies UserAction }),
    handleError: vi
      .fn()
      .mockResolvedValue({ action: "abort" satisfies UserAction }),
    handleAmbiguous: vi
      .fn()
      .mockResolvedValue({ action: "halt" satisfies UserAction }),
    confirmMerge: vi.fn().mockResolvedValue(true),
    reportCompletion: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const BASE_CTX: Omit<StageContext, "iteration" | "userInstruction"> = {
  owner: "org",
  repo: "repo",
  issueNumber: 5,
  branch: "issue-5",
  worktreePath: "/tmp/wt",
};

const ISSUE_CTX = {
  issueTitle: "Fix bug",
  issueBody: "Something is broken.",
};

function makePipelineOpts(
  overrides: Partial<PipelineOptions> = {},
): PipelineOptions {
  return {
    mode: "auto",
    stages: [],
    prompt: makePrompt(),
    context: BASE_CTX,
    ...overrides,
  };
}

// ---- Stage 2 through pipeline ----------------------------------------------

describe("Stage 2 (Implement) through pipeline", () => {
  test("completes pipeline when agent says COMPLETED", async () => {
    const implResult = makeResult({ sessionId: "s1", responseText: "Done." });
    const checkResult = makeResult({ responseText: "COMPLETED" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(implResult)),
      resume: vi.fn().mockReturnValue(makeStream(checkResult)),
    };

    const stage = createImplementStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));

    expect(result.success).toBe(true);
  });

  test("blocked → user halts → pipeline aborts", async () => {
    const implResult = makeResult({ sessionId: "s1" });
    const checkResult = makeResult({ responseText: "BLOCKED" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(implResult)),
      resume: vi.fn().mockReturnValue(makeStream(checkResult)),
    };
    const prompt = makePrompt({
      handleBlocked: vi.fn().mockResolvedValue({ action: "halt" }),
    });

    const stage = createImplementStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(false);
    expect(result.stoppedAt).toBe(2);
  });

  test("blocked → user instructs → agent retries and completes", async () => {
    let callCount = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        callCount++;
        return makeStream(
          makeResult({ sessionId: `s${callCount}`, responseText: "impl" }),
        );
      }),
      resume: vi.fn().mockImplementation(() => {
        if (callCount === 1) {
          return makeStream(makeResult({ responseText: "BLOCKED" }));
        }
        return makeStream(makeResult({ responseText: "COMPLETED" }));
      }),
    };
    const prompt = makePrompt({
      handleBlocked: vi.fn().mockResolvedValueOnce({
        action: "instruct",
        instruction: "try approach B",
      }),
    });

    const stage = createImplementStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(true);
    expect(callCount).toBe(2);
  });

  test("agent error → user retries → succeeds", async () => {
    let callCount = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return makeStream(
            makeResult({
              status: "error",
              errorType: "execution_error",
              stderrText: "timeout",
              responseText: "",
            }),
          );
        }
        return makeStream(makeResult({ sessionId: "s2", responseText: "ok" }));
      }),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };
    const prompt = makePrompt({
      handleError: vi.fn().mockResolvedValueOnce({ action: "retry" }),
    });

    const stage = createImplementStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(true);
    expect(callCount).toBe(2);
  });

  test("NOT_APPROVED on check → pipeline loops → COMPLETED", async () => {
    let callCount = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        callCount++;
        return makeStream(
          makeResult({ sessionId: `s${callCount}`, responseText: "impl" }),
        );
      }),
      resume: vi.fn().mockImplementation(() => {
        if (callCount === 1) {
          return makeStream(makeResult({ responseText: "NOT_APPROVED" }));
        }
        return makeStream(makeResult({ responseText: "COMPLETED" }));
      }),
    };

    const stage = createImplementStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));

    expect(result.success).toBe(true);
    expect(callCount).toBe(2);
  });

  test("ambiguous check → auto-clarification → completed", async () => {
    let callCount = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        callCount++;
        return makeStream(
          makeResult({ sessionId: `s${callCount}`, responseText: "impl" }),
        );
      }),
      resume: vi.fn().mockImplementation(() => {
        if (callCount === 1) {
          return makeStream(makeResult({ responseText: "maybe done?" }));
        }
        return makeStream(makeResult({ responseText: "COMPLETED" }));
      }),
    };

    const stage = createImplementStageHandler({ agent, ...ISSUE_CTX });
    const prompt = makePrompt();
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(true);
    // Auto-clarification should not call handleAmbiguous.
    expect(prompt.handleAmbiguous).not.toHaveBeenCalled();
  });
});

// ---- Stage 3 through pipeline ----------------------------------------------

describe("Stage 3 (Self-check) through pipeline", () => {
  test("DONE on first check → pipeline completes", async () => {
    const checkResult = makeResult({
      sessionId: "s1",
      responseText: "Review.",
    });
    const fixResult = makeResult({ responseText: "All good.\n\nDONE" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(checkResult)),
      resume: vi.fn().mockReturnValue(makeStream(fixResult)),
    };

    const stage = createSelfCheckStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));

    expect(result.success).toBe(true);
  });

  test("FIXED → loops → DONE: pipeline completes", async () => {
    let invokeCalls = 0;
    let resumeCalls = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        invokeCalls++;
        return makeStream(
          makeResult({
            sessionId: `s${invokeCalls}`,
            responseText: "Review.",
          }),
        );
      }),
      resume: vi.fn().mockImplementation(() => {
        resumeCalls++;
        if (resumeCalls < 3) {
          return makeStream(makeResult({ responseText: "FIXED" }));
        }
        return makeStream(makeResult({ responseText: "DONE" }));
      }),
    };

    const stage = createSelfCheckStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));

    expect(result.success).toBe(true);
    expect(invokeCalls).toBe(3); // 3 self-check rounds
    expect(resumeCalls).toBe(3); // 3 fix-or-done rounds
  });

  test("FIXED 3x → budget exhausted → user approves → DONE", async () => {
    let invokeCalls = 0;
    let resumeCalls = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        invokeCalls++;
        return makeStream(
          makeResult({ sessionId: `s${invokeCalls}`, responseText: "rev" }),
        );
      }),
      resume: vi.fn().mockImplementation(() => {
        resumeCalls++;
        if (resumeCalls <= 3) {
          return makeStream(makeResult({ responseText: "FIXED" }));
        }
        return makeStream(makeResult({ responseText: "DONE" }));
      }),
    };
    const prompt = makePrompt({
      confirmContinueLoop: vi.fn().mockResolvedValueOnce(true),
    });

    const stage = createSelfCheckStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(true);
    expect(prompt.confirmContinueLoop).toHaveBeenCalledTimes(1);
    expect(invokeCalls).toBe(4);
  });

  test("FIXED 3x → budget exhausted → user declines → pipeline aborts", async () => {
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockImplementation(() =>
          makeStream(makeResult({ sessionId: "s1", responseText: "check" })),
        ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "FIXED" }))),
    };
    const prompt = makePrompt({
      confirmContinueLoop: vi.fn().mockResolvedValue(false),
    });

    const stage = createSelfCheckStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(false);
    expect(result.stoppedAt).toBe(3);
  });

  test("self-check error → user aborts → pipeline fails", async () => {
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
    const prompt = makePrompt({
      handleError: vi.fn().mockResolvedValue({ action: "abort" }),
    });

    const stage = createSelfCheckStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(false);
    expect(prompt.handleError).toHaveBeenCalled();
  });

  test("fix-or-done error → user retries → DONE", async () => {
    let invokeCalls = 0;
    let resumeCalls = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        invokeCalls++;
        return makeStream(
          makeResult({
            sessionId: `s${invokeCalls}`,
            responseText: "review",
          }),
        );
      }),
      resume: vi.fn().mockImplementation(() => {
        resumeCalls++;
        if (resumeCalls === 1) {
          return makeStream(
            makeResult({
              status: "error",
              errorType: "execution_error",
              stderrText: "timeout",
              responseText: "",
            }),
          );
        }
        return makeStream(makeResult({ responseText: "DONE" }));
      }),
    };
    const prompt = makePrompt({
      handleError: vi.fn().mockResolvedValueOnce({ action: "retry" }),
    });

    const stage = createSelfCheckStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(true);
    expect(invokeCalls).toBe(2);
  });

  test("ambiguous fix → auto-clarification → DONE", async () => {
    let invokeCalls = 0;
    let resumeCalls = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        invokeCalls++;
        return makeStream(
          makeResult({
            sessionId: `s${invokeCalls}`,
            responseText: "review",
          }),
        );
      }),
      resume: vi.fn().mockImplementation(() => {
        resumeCalls++;
        if (resumeCalls === 1) {
          // First fix response is ambiguous
          return makeStream(makeResult({ responseText: "maybe ok?" }));
        }
        // After auto-clarification loops back, second round succeeds
        return makeStream(makeResult({ responseText: "DONE" }));
      }),
    };

    const stage = createSelfCheckStageHandler({ agent, ...ISSUE_CTX });
    const prompt = makePrompt();
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(true);
    expect(prompt.handleAmbiguous).not.toHaveBeenCalled();
  });

  test("blocked during fix → user instructs → completes next round", async () => {
    let invokeCalls = 0;
    let resumeCalls = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        invokeCalls++;
        return makeStream(
          makeResult({
            sessionId: `s${invokeCalls}`,
            responseText: "review",
          }),
        );
      }),
      resume: vi.fn().mockImplementation(() => {
        resumeCalls++;
        if (resumeCalls === 1) {
          return makeStream(makeResult({ responseText: "BLOCKED" }));
        }
        return makeStream(makeResult({ responseText: "DONE" }));
      }),
    };
    const prompt = makePrompt({
      handleBlocked: vi.fn().mockResolvedValueOnce({
        action: "instruct",
        instruction: "skip the flaky test",
      }),
    });

    const stage = createSelfCheckStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(true);
    expect(invokeCalls).toBe(2);
  });
});

// ---- CI helpers for stage 5 ------------------------------------------------

function makeCiRun(overrides: Partial<CiRun> = {}): CiRun {
  return {
    databaseId: 100,
    name: "build",
    status: "completed",
    conclusion: "success",
    headBranch: "issue-5",
    ...overrides,
  };
}

function makeCiStatus(verdict: CiVerdict, runs: CiRun[] = []): CiStatus {
  return { verdict, runs };
}

// ---- Stage 4 through pipeline ----------------------------------------------

describe("Stage 4 (Create PR) through pipeline", () => {
  test("completes pipeline when agent says COMPLETED", async () => {
    const prResult = makeResult({
      sessionId: "s1",
      responseText: "PR created.",
    });
    const checkResult = makeResult({ responseText: "COMPLETED" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(prResult)),
      resume: vi.fn().mockReturnValue(makeStream(checkResult)),
    };

    const stage = createCreatePrStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));

    expect(result.success).toBe(true);
  });

  test("blocked with requiresArtifact: handleBlocked called with allowProceed=false", async () => {
    const prResult = makeResult({ sessionId: "s1" });
    const checkResult = makeResult({ responseText: "BLOCKED" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(prResult)),
      resume: vi.fn().mockReturnValue(makeStream(checkResult)),
    };
    const handleBlocked = vi.fn().mockResolvedValue({ action: "halt" });
    const prompt = makePrompt({ handleBlocked });

    const stage = createCreatePrStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(false);
    expect(result.stoppedAt).toBe(4);
    // allowProceed should be false because requiresArtifact is true
    expect(handleBlocked).toHaveBeenCalledWith(expect.any(String), false);
  });

  test("blocked → user instructs → agent retries and completes", async () => {
    let callCount = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        callCount++;
        return makeStream(
          makeResult({ sessionId: `s${callCount}`, responseText: "pr" }),
        );
      }),
      resume: vi.fn().mockImplementation(() => {
        if (callCount === 1) {
          return makeStream(makeResult({ responseText: "BLOCKED" }));
        }
        return makeStream(makeResult({ responseText: "COMPLETED" }));
      }),
    };
    const prompt = makePrompt({
      handleBlocked: vi.fn().mockResolvedValueOnce({
        action: "instruct",
        instruction: "try draft PR",
      }),
    });

    const stage = createCreatePrStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(true);
    expect(callCount).toBe(2);
  });

  test("ambiguous check → auto-clarification → completed", async () => {
    let callCount = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        callCount++;
        return makeStream(
          makeResult({ sessionId: `s${callCount}`, responseText: "pr" }),
        );
      }),
      resume: vi.fn().mockImplementation(() => {
        if (callCount === 1) {
          return makeStream(makeResult({ responseText: "I think it worked?" }));
        }
        return makeStream(makeResult({ responseText: "COMPLETED" }));
      }),
    };
    const prompt = makePrompt();

    const stage = createCreatePrStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(true);
    expect(prompt.handleAmbiguous).not.toHaveBeenCalled();
  });

  test("agent error → user retries → succeeds", async () => {
    let callCount = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return makeStream(
            makeResult({
              status: "error",
              errorType: "execution_error",
              stderrText: "timeout",
              responseText: "",
            }),
          );
        }
        return makeStream(makeResult({ sessionId: "s2", responseText: "ok" }));
      }),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };
    const prompt = makePrompt({
      handleError: vi.fn().mockResolvedValueOnce({ action: "retry" }),
    });

    const stage = createCreatePrStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(true);
    expect(callCount).toBe(2);
  });
});

// ---- Stage 5 through pipeline ----------------------------------------------

describe("Stage 5 (CI check) through pipeline", () => {
  test("CI passes on first poll: pipeline advances", async () => {
    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi.fn(),
    };
    const stage = createCiCheckStageHandler({
      agent,
      ...ISSUE_CTX,
      getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
      collectFailureLogs: vi.fn(),
      delay: vi.fn().mockResolvedValue(undefined),
    });

    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));

    expect(result.success).toBe(true);
    expect(agent.invoke).not.toHaveBeenCalled();
  });

  test("CI fails, agent fixes, CI passes next poll: pipeline advances", async () => {
    let pollCount = 0;
    const getCiStatus = vi.fn().mockImplementation(() => {
      pollCount++;
      if (pollCount === 1) {
        return makeCiStatus("fail", [
          makeCiRun({ conclusion: "failure", databaseId: 200 }),
        ]);
      }
      return makeCiStatus("pass");
    });

    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "Fixed CI." }))),
      resume: vi.fn(),
    };

    const stage = createCiCheckStageHandler({
      agent,
      ...ISSUE_CTX,
      getCiStatus,
      collectFailureLogs: vi.fn().mockReturnValue("test error"),
      delay: vi.fn().mockResolvedValue(undefined),
    });

    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));

    expect(result.success).toBe(true);
    expect(pollCount).toBe(2);
    expect(agent.invoke).toHaveBeenCalledTimes(1);
  });

  test("CI fails 3x → budget exhausted → user approves → CI passes", async () => {
    let pollCount = 0;
    const getCiStatus = vi.fn().mockImplementation(() => {
      pollCount++;
      if (pollCount <= 3) {
        return makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]);
      }
      return makeCiStatus("pass");
    });

    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "Fixed." }))),
      resume: vi.fn(),
    };
    const prompt = makePrompt({
      confirmContinueLoop: vi.fn().mockResolvedValueOnce(true),
    });

    const stage = createCiCheckStageHandler({
      agent,
      ...ISSUE_CTX,
      getCiStatus,
      collectFailureLogs: vi.fn().mockReturnValue("err"),
      delay: vi.fn().mockResolvedValue(undefined),
    });

    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(true);
    expect(prompt.confirmContinueLoop).toHaveBeenCalledTimes(1);
    expect(pollCount).toBe(4);
  });

  test("CI fails 3x → budget exhausted → user declines → pipeline aborts", async () => {
    const getCiStatus = vi
      .fn()
      .mockReturnValue(
        makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]),
      );

    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "Fixed." }))),
      resume: vi.fn(),
    };
    const prompt = makePrompt({
      confirmContinueLoop: vi.fn().mockResolvedValue(false),
    });

    const stage = createCiCheckStageHandler({
      agent,
      ...ISSUE_CTX,
      getCiStatus,
      collectFailureLogs: vi.fn().mockReturnValue("err"),
      delay: vi.fn().mockResolvedValue(undefined),
    });

    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(false);
    expect(result.stoppedAt).toBe(5);
  });
});

// ---- Stage 6 through pipeline ----------------------------------------------

describe("Stage 6 (Test plan verification) through pipeline", () => {
  test("DONE on first check → pipeline completes", async () => {
    const verifyResult = makeResult({
      sessionId: "s1",
      responseText: "Verified.",
    });
    const checkResult = makeResult({ responseText: "All good.\n\nDONE" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(verifyResult)),
      resume: vi.fn().mockReturnValue(makeStream(checkResult)),
    };

    const stage = createTestPlanStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));

    expect(result.success).toBe(true);
  });

  test("FIXED → loops → DONE: pipeline completes", async () => {
    let invokeCalls = 0;
    let resumeCalls = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        invokeCalls++;
        return makeStream(
          makeResult({
            sessionId: `s${invokeCalls}`,
            responseText: "Verified.",
          }),
        );
      }),
      resume: vi.fn().mockImplementation(() => {
        resumeCalls++;
        if (resumeCalls < 3) {
          return makeStream(makeResult({ responseText: "FIXED" }));
        }
        return makeStream(makeResult({ responseText: "DONE" }));
      }),
    };

    const stage = createTestPlanStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));

    expect(result.success).toBe(true);
    expect(invokeCalls).toBe(3);
    expect(resumeCalls).toBe(3);
  });

  test("FIXED 3x → budget exhausted → user approves → DONE", async () => {
    let invokeCalls = 0;
    let resumeCalls = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        invokeCalls++;
        return makeStream(
          makeResult({ sessionId: `s${invokeCalls}`, responseText: "ver" }),
        );
      }),
      resume: vi.fn().mockImplementation(() => {
        resumeCalls++;
        if (resumeCalls <= 3) {
          return makeStream(makeResult({ responseText: "FIXED" }));
        }
        return makeStream(makeResult({ responseText: "DONE" }));
      }),
    };
    const prompt = makePrompt({
      confirmContinueLoop: vi.fn().mockResolvedValueOnce(true),
    });

    const stage = createTestPlanStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(true);
    expect(prompt.confirmContinueLoop).toHaveBeenCalledTimes(1);
    expect(invokeCalls).toBe(4);
  });

  test("FIXED 3x → budget exhausted → user declines → pipeline aborts", async () => {
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockImplementation(() =>
          makeStream(makeResult({ sessionId: "s1", responseText: "verify" })),
        ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "FIXED" }))),
    };
    const prompt = makePrompt({
      confirmContinueLoop: vi.fn().mockResolvedValue(false),
    });

    const stage = createTestPlanStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(false);
    expect(result.stoppedAt).toBe(6);
  });

  test("verify error → user retries → DONE", async () => {
    let invokeCalls = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        invokeCalls++;
        if (invokeCalls === 1) {
          return makeStream(
            makeResult({
              status: "error",
              errorType: "execution_error",
              stderrText: "timeout",
              responseText: "",
            }),
          );
        }
        return makeStream(
          makeResult({
            sessionId: `s${invokeCalls}`,
            responseText: "verified",
          }),
        );
      }),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "DONE" }))),
    };
    const prompt = makePrompt({
      handleError: vi.fn().mockResolvedValueOnce({ action: "retry" }),
    });

    const stage = createTestPlanStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(true);
    expect(invokeCalls).toBe(2);
  });

  test("ambiguous self-check → auto-clarification → DONE", async () => {
    let invokeCalls = 0;
    let resumeCalls = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        invokeCalls++;
        return makeStream(
          makeResult({
            sessionId: `s${invokeCalls}`,
            responseText: "verified",
          }),
        );
      }),
      resume: vi.fn().mockImplementation(() => {
        resumeCalls++;
        if (resumeCalls === 1) {
          return makeStream(makeResult({ responseText: "looks ok maybe?" }));
        }
        return makeStream(makeResult({ responseText: "DONE" }));
      }),
    };
    const prompt = makePrompt();

    const stage = createTestPlanStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(true);
    expect(prompt.handleAmbiguous).not.toHaveBeenCalled();
  });

  test("blocked during self-check → user instructs → completes next round", async () => {
    let invokeCalls = 0;
    let resumeCalls = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        invokeCalls++;
        return makeStream(
          makeResult({
            sessionId: `s${invokeCalls}`,
            responseText: "verified",
          }),
        );
      }),
      resume: vi.fn().mockImplementation(() => {
        resumeCalls++;
        if (resumeCalls === 1) {
          return makeStream(makeResult({ responseText: "BLOCKED" }));
        }
        return makeStream(makeResult({ responseText: "DONE" }));
      }),
    };
    const prompt = makePrompt({
      handleBlocked: vi.fn().mockResolvedValueOnce({
        action: "instruct",
        instruction: "skip the flaky check",
      }),
    });

    const stage = createTestPlanStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(true);
    expect(invokeCalls).toBe(2);
  });

  test("self-check error → user aborts → pipeline fails", async () => {
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ sessionId: "s1", responseText: "verified" })),
        ),
      resume: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            status: "error",
            errorType: "max_turns",
            responseText: "",
          }),
        ),
      ),
    };
    const prompt = makePrompt({
      handleError: vi.fn().mockResolvedValue({ action: "abort" }),
    });

    const stage = createTestPlanStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(false);
    expect(prompt.handleError).toHaveBeenCalled();
  });
});

// ---- Multi-stage E2E: Stage 4 → Stage 5 → Stage 6 -------------------------

describe("Multi-stage E2E: Stage 4 → Stage 5 → Stage 6", () => {
  test("PR created, CI passes, test plan verified: full flow success", async () => {
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation((prompt: string) => {
        if (prompt.includes("creating a pull request")) {
          return makeStream(
            makeResult({ sessionId: "pr-1", responseText: "PR created." }),
          );
        }
        // Test plan verification
        return makeStream(
          makeResult({ sessionId: "tp-1", responseText: "Verified." }),
        );
      }),
      resume: vi.fn().mockImplementation((_sid: string, prompt: string) => {
        if (prompt.includes("PR creation attempt")) {
          return makeStream(makeResult({ responseText: "COMPLETED" }));
        }
        // Test plan self-check
        return makeStream(makeResult({ responseText: "DONE" }));
      }),
    };

    const prStage = createCreatePrStageHandler({ agent, ...ISSUE_CTX });
    const ciStage = createCiCheckStageHandler({
      agent,
      ...ISSUE_CTX,
      getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
      collectFailureLogs: vi.fn(),
      delay: vi.fn().mockResolvedValue(undefined),
    });
    const tpStage = createTestPlanStageHandler({ agent, ...ISSUE_CTX });

    const result = await runPipeline(
      makePipelineOpts({ stages: [prStage, ciStage, tpStage] }),
    );

    expect(result.success).toBe(true);
  });

  test("test plan FIXED → restarts from CI check → CI passes → test plan DONE", async () => {
    let ciPollCount = 0;
    const getCiStatus = vi.fn().mockImplementation(() => {
      ciPollCount++;
      return makeCiStatus("pass");
    });

    let tpResumeCalls = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation((prompt: string) => {
        if (prompt.includes("creating a pull request")) {
          return makeStream(
            makeResult({ sessionId: "pr-1", responseText: "PR created." }),
          );
        }
        // Test plan verification (called multiple times due to restart)
        return makeStream(
          makeResult({ sessionId: "tp-1", responseText: "Verified." }),
        );
      }),
      resume: vi.fn().mockImplementation((_sid: string, prompt: string) => {
        if (prompt.includes("PR creation attempt")) {
          return makeStream(makeResult({ responseText: "COMPLETED" }));
        }
        // Test plan self-check
        tpResumeCalls++;
        if (tpResumeCalls === 1) {
          return makeStream(makeResult({ responseText: "FIXED" }));
        }
        return makeStream(makeResult({ responseText: "DONE" }));
      }),
    };

    const prStage = createCreatePrStageHandler({ agent, ...ISSUE_CTX });
    const ciStage = createCiCheckStageHandler({
      agent,
      ...ISSUE_CTX,
      getCiStatus,
      collectFailureLogs: vi.fn(),
      delay: vi.fn().mockResolvedValue(undefined),
    });
    const tpStage = {
      ...createTestPlanStageHandler({ agent, ...ISSUE_CTX }),
      restartFromStage: 5,
    };

    const result = await runPipeline(
      makePipelineOpts({ stages: [prStage, ciStage, tpStage] }),
    );

    expect(result.success).toBe(true);
    // CI polled twice: once on initial pass-through, once on restart
    expect(ciPollCount).toBe(2);
    expect(tpResumeCalls).toBe(2);
  });

  test("test plan FIXED 3x → restart budget exhausted → user declines", async () => {
    const getCiStatus = vi.fn().mockReturnValue(makeCiStatus("pass"));

    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation((prompt: string) => {
        if (prompt.includes("creating a pull request")) {
          return makeStream(
            makeResult({ sessionId: "pr-1", responseText: "PR created." }),
          );
        }
        return makeStream(
          makeResult({ sessionId: "tp-1", responseText: "Verified." }),
        );
      }),
      resume: vi.fn().mockImplementation((_sid: string, prompt: string) => {
        if (prompt.includes("PR creation attempt")) {
          return makeStream(makeResult({ responseText: "COMPLETED" }));
        }
        // Always FIXED — never done
        return makeStream(makeResult({ responseText: "FIXED" }));
      }),
    };
    const prompt = makePrompt({
      confirmContinueLoop: vi.fn().mockResolvedValue(false),
    });

    const prStage = createCreatePrStageHandler({ agent, ...ISSUE_CTX });
    const ciStage = createCiCheckStageHandler({
      agent,
      ...ISSUE_CTX,
      getCiStatus,
      collectFailureLogs: vi.fn(),
      delay: vi.fn().mockResolvedValue(undefined),
    });
    const tpStage = {
      ...createTestPlanStageHandler({ agent, ...ISSUE_CTX }),
      restartFromStage: 5,
    };

    const result = await runPipeline(
      makePipelineOpts({ stages: [prStage, ciStage, tpStage], prompt }),
    );

    expect(result.success).toBe(false);
    expect(result.stoppedAt).toBe(6);
    expect(prompt.confirmContinueLoop).toHaveBeenCalledTimes(1);
  });
});

// ---- Multi-stage E2E: Stage 2 → Stage 3 -----------------------------------

describe("Multi-stage E2E: Stage 2 → Stage 3", () => {
  test("implement completes → self-check DONE → pipeline succeeds", async () => {
    let implInvokeCalls = 0;
    let implResumeCalls = 0;
    let scInvokeCalls = 0;
    let scResumeCalls = 0;

    // We need a single agent adapter that handles both stages.
    // Stage 2 invokes first, then Stage 3.
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation((prompt: string) => {
        if (prompt.includes("implementing a solution")) {
          implInvokeCalls++;
          return makeStream(
            makeResult({
              sessionId: `impl-${implInvokeCalls}`,
              responseText: "Code written.",
            }),
          );
        }
        // Self-check invoke
        scInvokeCalls++;
        return makeStream(
          makeResult({
            sessionId: `sc-${scInvokeCalls}`,
            responseText: "Review complete.",
          }),
        );
      }),
      resume: vi.fn().mockImplementation((_sid: string, prompt: string) => {
        if (prompt.includes("evaluate the")) {
          implResumeCalls++;
          return makeStream(makeResult({ responseText: "COMPLETED" }));
        }
        // Fix-or-done
        scResumeCalls++;
        return makeStream(makeResult({ responseText: "DONE" }));
      }),
    };

    const implementStage = createImplementStageHandler({
      agent,
      ...ISSUE_CTX,
    });
    const selfCheckStage = createSelfCheckStageHandler({
      agent,
      ...ISSUE_CTX,
    });

    const result = await runPipeline(
      makePipelineOpts({ stages: [implementStage, selfCheckStage] }),
    );

    expect(result.success).toBe(true);
    expect(implInvokeCalls).toBe(1);
    expect(implResumeCalls).toBe(1);
    expect(scInvokeCalls).toBe(1);
    expect(scResumeCalls).toBe(1);
  });

  test("implement completes → self-check FIXED twice then DONE", async () => {
    let scResumeCalls = 0;

    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation((prompt: string) => {
        if (prompt.includes("implementing a solution")) {
          return makeStream(
            makeResult({ sessionId: "impl-1", responseText: "Done." }),
          );
        }
        return makeStream(
          makeResult({ sessionId: "sc-1", responseText: "Review." }),
        );
      }),
      resume: vi.fn().mockImplementation((_sid: string, prompt: string) => {
        if (prompt.includes("evaluate the")) {
          return makeStream(makeResult({ responseText: "COMPLETED" }));
        }
        scResumeCalls++;
        if (scResumeCalls <= 2) {
          return makeStream(makeResult({ responseText: "FIXED" }));
        }
        return makeStream(makeResult({ responseText: "DONE" }));
      }),
    };

    const implementStage = createImplementStageHandler({
      agent,
      ...ISSUE_CTX,
    });
    const selfCheckStage = createSelfCheckStageHandler({
      agent,
      ...ISSUE_CTX,
    });

    const result = await runPipeline(
      makePipelineOpts({ stages: [implementStage, selfCheckStage] }),
    );

    expect(result.success).toBe(true);
    expect(scResumeCalls).toBe(3);
  });

  test("step mode asks before each stage", async () => {
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockImplementation(() =>
          makeStream(makeResult({ sessionId: "s1", responseText: "ok" })),
        ),
      resume: vi.fn().mockImplementation((_sid: string, prompt: string) => {
        if (prompt.includes("evaluate the")) {
          return makeStream(makeResult({ responseText: "COMPLETED" }));
        }
        return makeStream(makeResult({ responseText: "DONE" }));
      }),
    };
    const prompt = makePrompt();

    const implementStage = createImplementStageHandler({
      agent,
      ...ISSUE_CTX,
    });
    const selfCheckStage = createSelfCheckStageHandler({
      agent,
      ...ISSUE_CTX,
    });

    await runPipeline(
      makePipelineOpts({
        mode: "step",
        stages: [implementStage, selfCheckStage],
        prompt,
      }),
    );

    expect(prompt.confirmNextStage).toHaveBeenCalledTimes(2);
    expect(prompt.confirmNextStage).toHaveBeenCalledWith("Implement");
    expect(prompt.confirmNextStage).toHaveBeenCalledWith("Self-check");
  });

  test("implement blocked → abort → self-check never runs", async () => {
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ sessionId: "s1", responseText: "impl" })),
        ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "BLOCKED" }))),
    };
    const prompt = makePrompt({
      handleBlocked: vi.fn().mockResolvedValue({ action: "halt" }),
    });

    const implementStage = createImplementStageHandler({
      agent,
      ...ISSUE_CTX,
    });
    const selfCheckStage = createSelfCheckStageHandler({
      agent,
      ...ISSUE_CTX,
    });

    const result = await runPipeline(
      makePipelineOpts({
        stages: [implementStage, selfCheckStage],
        prompt,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.stoppedAt).toBe(2);
    // Agent should have been invoked only for Stage 2
    expect(agent.invoke).toHaveBeenCalledTimes(1);
  });
});

// ---- Stage 7 (Squash) through pipeline ---------------------------------------

describe("Stage 7 (Squash) through pipeline", () => {
  test("completes when squash succeeds and CI passes", async () => {
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "s1", responseText: "Squashed." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };

    const stage = createSquashStageHandler({
      agent,
      ...ISSUE_CTX,
      getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
      collectFailureLogs: vi.fn().mockReturnValue(""),
      delay: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 100,
      pollTimeoutMs: 1000,
    });

    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));
    expect(result.success).toBe(true);
  });

  test("blocked → user halts → pipeline aborts", async () => {
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "s1", responseText: "Cannot squash." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "BLOCKED" }))),
    };
    const prompt = makePrompt({
      handleBlocked: vi.fn().mockResolvedValue({ action: "halt" }),
    });

    const stage = createSquashStageHandler({
      agent,
      ...ISSUE_CTX,
      getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
      collectFailureLogs: vi.fn().mockReturnValue(""),
      delay: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 100,
      pollTimeoutMs: 1000,
    });

    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );
    expect(result.success).toBe(false);
    expect(result.stoppedAt).toBe(7);
  });
});

// ---- Stage 8 (Review) through pipeline ---------------------------------------

describe("Stage 8 (Review) through pipeline", () => {
  test("completes when Agent B approves on first round", async () => {
    const agentA: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi.fn(),
    };

    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sb",
            responseText: "Looks good.\n\nAPPROVED",
          }),
        ),
      ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "NONE" }))),
    };

    const stage = createReviewStageHandler({
      agentA,
      agentB,
      ...ISSUE_CTX,
      getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
      collectFailureLogs: vi.fn().mockReturnValue(""),
      delay: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 100,
      pollTimeoutMs: 1000,
    });

    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));
    expect(result.success).toBe(true);
    expect(agentA.invoke).not.toHaveBeenCalled();
  });

  test("NOT_APPROVED → fix → CI pass → loops → APPROVED: completes", async () => {
    let bInvokeCalls = 0;
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        bInvokeCalls++;
        if (bInvokeCalls === 1) {
          return makeStream(
            makeResult({
              sessionId: "sb1",
              responseText: "NOT_APPROVED",
            }),
          );
        }
        return makeStream(
          makeResult({
            sessionId: "sb2",
            responseText: "APPROVED",
          }),
        );
      }),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "NONE" }))),
    };

    const agentA: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sa1",
            responseText: "Fixed.",
          }),
        ),
      ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };

    const stage = createReviewStageHandler({
      agentA,
      agentB,
      ...ISSUE_CTX,
      getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
      collectFailureLogs: vi.fn().mockReturnValue(""),
      delay: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 100,
      pollTimeoutMs: 1000,
    });

    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));
    expect(result.success).toBe(true);
    expect(bInvokeCalls).toBe(2);
  });

  test("3 rounds NOT_APPROVED → budget exhausted → user declines → aborts", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sb",
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
            sessionId: "sa",
            responseText: "Fixed.",
          }),
        ),
      ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };

    const prompt = makePrompt({
      confirmContinueLoop: vi.fn().mockResolvedValue(false),
    });

    const stage = {
      ...createReviewStageHandler({
        agentA,
        agentB,
        ...ISSUE_CTX,
        getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
        collectFailureLogs: vi.fn().mockReturnValue(""),
        delay: vi.fn().mockResolvedValue(undefined),
        pollIntervalMs: 100,
        pollTimeoutMs: 1000,
      }),
      autoBudget: 3,
    };

    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );
    expect(result.success).toBe(false);
    expect(prompt.confirmContinueLoop).toHaveBeenCalled();
  });

  test("3 rounds NOT_APPROVED → budget exhausted → user approves → APPROVED", async () => {
    let bInvokeCalls = 0;
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        bInvokeCalls++;
        if (bInvokeCalls <= 3) {
          return makeStream(
            makeResult({
              sessionId: `sb${bInvokeCalls}`,
              responseText: "NOT_APPROVED",
            }),
          );
        }
        return makeStream(
          makeResult({
            sessionId: `sb${bInvokeCalls}`,
            responseText: "APPROVED",
          }),
        );
      }),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "NONE" }))),
    };

    const agentA: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sa",
            responseText: "Fixed.",
          }),
        ),
      ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };

    const prompt = makePrompt({
      confirmContinueLoop: vi.fn().mockResolvedValue(true),
    });

    const stage = {
      ...createReviewStageHandler({
        agentA,
        agentB,
        ...ISSUE_CTX,
        getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
        collectFailureLogs: vi.fn().mockReturnValue(""),
        delay: vi.fn().mockResolvedValue(undefined),
        pollIntervalMs: 100,
        pollTimeoutMs: 1000,
      }),
      autoBudget: 3,
    };

    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );
    expect(result.success).toBe(true);
    expect(bInvokeCalls).toBe(4);
    expect(prompt.confirmContinueLoop).toHaveBeenCalledTimes(1);
  });

  test("CI error during fix flow → pipeline aborts", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sb",
            responseText: "NOT_APPROVED",
          }),
        ),
      ),
      resume: vi.fn(),
    };

    const getCiStatus = vi
      .fn()
      .mockReturnValue(
        makeCiStatus("fail", [makeCiRun({ conclusion: "failure" })]),
      );

    // Agent A: first call is fix, rest are CI fix attempts (all "succeed" but CI keeps failing)
    const agentA: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sa",
            responseText: "Fixed.",
          }),
        ),
      ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };

    const prompt = makePrompt({
      handleError: vi.fn().mockResolvedValue({ action: "abort" }),
    });

    const stage = createReviewStageHandler({
      agentA,
      agentB,
      ...ISSUE_CTX,
      getCiStatus,
      collectFailureLogs: vi.fn().mockReturnValue("test err"),
      delay: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 100,
      pollTimeoutMs: 1000,
      maxFixAttempts: 3,
    });

    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );
    expect(result.success).toBe(false);
  });
});

// ---- Stages 7+8 combined through pipeline ------------------------------------

describe("Stages 7+8 (Squash + Review) through pipeline", () => {
  test("squash succeeds → CI passes → review approves: pipeline completes", async () => {
    const squashAgent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sq1", responseText: "Squashed." }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };

    const agentA: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi.fn(),
    };

    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sb",
            responseText: "APPROVED",
          }),
        ),
      ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "NONE" }))),
    };

    const getCiStatus = vi.fn().mockReturnValue(makeCiStatus("pass"));

    const squashStage = createSquashStageHandler({
      agent: squashAgent,
      ...ISSUE_CTX,
      getCiStatus,
      collectFailureLogs: vi.fn().mockReturnValue(""),
      delay: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 100,
      pollTimeoutMs: 1000,
    });

    const reviewStage = createReviewStageHandler({
      agentA,
      agentB,
      ...ISSUE_CTX,
      getCiStatus,
      collectFailureLogs: vi.fn().mockReturnValue(""),
      delay: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 100,
      pollTimeoutMs: 1000,
    });

    const result = await runPipeline(
      makePipelineOpts({ stages: [squashStage, reviewStage] }),
    );
    expect(result.success).toBe(true);
    expect(squashAgent.invoke).toHaveBeenCalledTimes(1);
    expect(agentB.invoke).toHaveBeenCalledTimes(1);
    expect(agentA.invoke).not.toHaveBeenCalled();
  });

  test("squash blocked → pipeline aborts before review", async () => {
    const squashAgent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ sessionId: "sq1", responseText: "Cannot." })),
        ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "BLOCKED" }))),
    };

    const agentB: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi.fn(),
    };

    const prompt = makePrompt({
      handleBlocked: vi.fn().mockResolvedValue({ action: "halt" }),
    });

    const squashStage = createSquashStageHandler({
      agent: squashAgent,
      ...ISSUE_CTX,
      getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
      collectFailureLogs: vi.fn().mockReturnValue(""),
      delay: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 100,
      pollTimeoutMs: 1000,
    });

    const reviewStage = createReviewStageHandler({
      agentA: { invoke: vi.fn(), resume: vi.fn() },
      agentB,
      ...ISSUE_CTX,
      getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
      collectFailureLogs: vi.fn().mockReturnValue(""),
      delay: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 100,
      pollTimeoutMs: 1000,
    });

    const result = await runPipeline(
      makePipelineOpts({ stages: [squashStage, reviewStage], prompt }),
    );
    expect(result.success).toBe(false);
    expect(result.stoppedAt).toBe(7);
    expect(agentB.invoke).not.toHaveBeenCalled();
  });
});
