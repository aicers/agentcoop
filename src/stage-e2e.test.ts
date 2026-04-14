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
import {
  type AgentChunkEvent,
  PipelineEventEmitter,
  type StageEnterEvent,
  type StageExitEvent,
} from "./pipeline-events.js";
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

function makeStreamWithChunks(
  result: AgentResult,
  chunks: string[],
): AgentStream {
  let idx = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          if (idx < chunks.length) {
            return { done: false, value: chunks[idx++] };
          }
          return { done: true, value: "" };
        },
      };
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
    confirmMerge: vi.fn().mockResolvedValue("merged"),
    handleConflict: vi.fn().mockResolvedValue("manual"),
    handleUnknownMergeable: vi.fn().mockResolvedValue("exit"),
    waitForManualResolve: vi.fn().mockResolvedValue(undefined),
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

  test("NOT_APPROVED on check → blocked (user intervention)", async () => {
    let callCount = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        callCount++;
        return makeStream(
          makeResult({ sessionId: `s${callCount}`, responseText: "impl" }),
        );
      }),
      // NOT_APPROVED is out-of-scope for implement — both the check
      // and the internal clarification retry return it, so the handler
      // falls back to "blocked" to surface the ambiguity to the user.
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
    };

    const prompt = makePrompt();
    const stage = createImplementStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(false);
    expect(prompt.handleBlocked).toHaveBeenCalled();
    expect(callCount).toBe(1);
  });

  test("ambiguous check → auto-clarification → completed", async () => {
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ sessionId: "s1", responseText: "impl" })),
        ),
      resume: vi
        .fn()
        .mockReturnValueOnce(
          makeStream(makeResult({ responseText: "maybe done?" })),
        )
        .mockReturnValueOnce(
          makeStream(makeResult({ responseText: "COMPLETED" })),
        ),
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
    const doneResult = makeResult({ responseText: "DONE" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(checkResult)),
      resume: vi.fn().mockReturnValue(makeStream(doneResult)),
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
      resume: vi.fn().mockImplementation((_s: string, prompt: string) => {
        resumeCalls++;
        if (prompt.includes("Report what issue sync")) {
          return makeStream(makeResult({ responseText: "ISSUE_NO_CHANGES" }));
        }
        // 3-step flow: odd = work, even = verdict per iteration.
        if (resumeCalls % 2 === 1) {
          return makeStream(makeResult({ responseText: "Applied fixes." }));
        }
        if (resumeCalls < 5) {
          // Even calls 2,4 = verdict FIXED
          return makeStream(makeResult({ responseText: "FIXED" }));
        }
        // Even calls >= 5: verdict DONE or issue sync work
        return makeStream(makeResult({ responseText: "DONE" }));
      }),
    };

    const stage = createSelfCheckStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));

    expect(result.success).toBe(true);
    expect(invokeCalls).toBe(3); // 3 self-check rounds
    expect(resumeCalls).toBe(8); // 3x(work+verdict) + issue sync + issue sync verdict
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
      resume: vi.fn().mockImplementation((_s: string, prompt: string) => {
        resumeCalls++;
        if (prompt.includes("Report what issue sync")) {
          return makeStream(makeResult({ responseText: "ISSUE_NO_CHANGES" }));
        }
        // 3-step flow: odd = work, even = verdict.
        if (resumeCalls % 2 === 1) {
          return makeStream(makeResult({ responseText: "Applied fixes." }));
        }
        if (resumeCalls <= 6) {
          // Even calls 2,4,6 = verdict FIXED (3 rounds)
          return makeStream(makeResult({ responseText: "FIXED" }));
        }
        // Even calls > 6: verdict DONE or issue sync work
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

  test("error during fix → user retries → completes next round", async () => {
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
          // Work step returns agent error on first round.
          return makeStream(
            makeResult({
              status: "error",
              errorType: "execution_error",
              stderrText: "timeout",
              responseText: "",
            }),
          );
        }
        // Subsequent rounds: work + verdict + sync all succeed.
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
});

// ---- CI helpers for stage 5 ------------------------------------------------

function makeCiRun(overrides: Partial<CiRun> = {}): CiRun {
  return {
    databaseId: 100,
    name: "build",
    status: "completed",
    conclusion: "success",
    headBranch: "issue-5",
    headSha: "abc123",
    source: "workflow",
    ...overrides,
  };
}

const stubGetHeadSha = () => "abc123";

function makeCiStatus(verdict: CiVerdict, runs: CiRun[] = []): CiStatus {
  return { verdict, runs, findings: [] };
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
      resume: vi
        .fn()
        .mockReturnValueOnce(
          makeStream(makeResult({ responseText: "I think it worked?" })),
        )
        .mockReturnValueOnce(
          makeStream(makeResult({ responseText: "COMPLETED" })),
        ),
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
      getHeadSha: stubGetHeadSha,
      emptyRunsGracePeriodMs: 0,
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
      getHeadSha: stubGetHeadSha,
      emptyRunsGracePeriodMs: 0,
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
      getHeadSha: stubGetHeadSha,
      emptyRunsGracePeriodMs: 0,
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
      getHeadSha: stubGetHeadSha,
      emptyRunsGracePeriodMs: 0,
    });

    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(false);
    expect(result.stoppedAt).toBe(5);
  });
});

// ---- Stage 5 SHA filtering E2E ---------------------------------------------

describe("Stage 5 (CI check) SHA filtering through pipeline", () => {
  test("getHeadSha is called and SHA is forwarded to getCiStatus", async () => {
    const getHeadSha = vi.fn().mockReturnValue("sha-after-push");
    const getCiStatus = vi.fn().mockReturnValue(makeCiStatus("pass"));
    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi.fn(),
    };
    const stage = createCiCheckStageHandler({
      agent,
      ...ISSUE_CTX,
      getCiStatus,
      getHeadSha,
      collectFailureLogs: vi.fn(),
      delay: vi.fn().mockResolvedValue(undefined),
      emptyRunsGracePeriodMs: 0,
    });

    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));

    expect(result.success).toBe(true);
    expect(getHeadSha).toHaveBeenCalledWith("/tmp/wt");
    expect(getCiStatus).toHaveBeenCalledWith(
      "org",
      "repo",
      "issue-5",
      "sha-after-push",
    );
  });

  test("SHA changes after fix push: new SHA used for re-poll", async () => {
    let shaCall = 0;
    const shas = ["sha-v1", "sha-v2"];
    const getHeadSha = vi.fn().mockImplementation(() => shas[shaCall++]);

    let pollCount = 0;
    const getCiStatus = vi
      .fn()
      .mockImplementation(
        (_o: string, _r: string, _b: string, sha?: string) => {
          pollCount++;
          if (pollCount === 1) {
            expect(sha).toBe("sha-v1");
            return makeCiStatus("fail", [
              makeCiRun({ conclusion: "failure", databaseId: 200 }),
            ]);
          }
          expect(sha).toBe("sha-v2");
          return makeCiStatus("pass");
        },
      );

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
      getHeadSha,
      collectFailureLogs: vi.fn().mockReturnValue("test error"),
      delay: vi.fn().mockResolvedValue(undefined),
      emptyRunsGracePeriodMs: 0,
    });

    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));

    expect(result.success).toBe(true);
    expect(getHeadSha).toHaveBeenCalledTimes(2);
    expect(getCiStatus).toHaveBeenCalledTimes(2);
  });

  test("no runs for new SHA yet: grace period prevents false-pass", async () => {
    // Key false-pass scenario from issue #24:
    // After a push, the workflow hasn't been created yet.  getCiStatus
    // returns pass with empty runs.  The grace period keeps polling
    // until the run appears.
    const getHeadSha = vi.fn().mockReturnValue("brand-new-sha");
    let pollCount = 0;
    const getCiStatus = vi.fn().mockImplementation(() => {
      pollCount++;
      if (pollCount <= 2) {
        // No runs match the new SHA yet → empty pass (within grace)
        return makeCiStatus("pass");
      }
      return makeCiStatus("pass", [
        makeCiRun({ conclusion: "success", headSha: "brand-new-sha" }),
      ]);
    });

    let elapsed = 0;
    const startTime = Date.now();
    const delay = vi.fn().mockImplementation(async () => {
      elapsed += 100;
    });
    vi.spyOn(Date, "now").mockImplementation(() => startTime + elapsed);

    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi.fn(),
    };

    const stage = createCiCheckStageHandler({
      agent,
      ...ISSUE_CTX,
      getCiStatus,
      getHeadSha,
      collectFailureLogs: vi.fn(),
      delay,
      emptyRunsGracePeriodMs: 500,
    });

    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));

    expect(result.success).toBe(true);
    expect(pollCount).toBe(3);
    expect(agent.invoke).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  test("no CI configured: accepts empty pass after grace period", async () => {
    const getHeadSha = vi.fn().mockReturnValue("some-sha");
    const getCiStatus = vi.fn().mockReturnValue(makeCiStatus("pass"));

    let elapsed = 0;
    const startTime = Date.now();
    const delay = vi.fn().mockImplementation(async () => {
      elapsed += 300;
    });
    vi.spyOn(Date, "now").mockImplementation(() => startTime + elapsed);

    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi.fn(),
    };

    const stage = createCiCheckStageHandler({
      agent,
      ...ISSUE_CTX,
      getCiStatus,
      getHeadSha,
      collectFailureLogs: vi.fn(),
      delay,
      emptyRunsGracePeriodMs: 500,
    });

    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));

    expect(result.success).toBe(true);
    expect(agent.invoke).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  test("stale run with old SHA is ignored, new SHA run is pending then passes", async () => {
    // Simulates the stale-failure scenario from issue #24:
    // getHeadSha returns the new SHA, getCiStatus only sees runs
    // matching that SHA (pending initially, then pass).
    const getHeadSha = vi.fn().mockReturnValue("new-sha");
    let pollCount = 0;
    const getCiStatus = vi.fn().mockImplementation(() => {
      pollCount++;
      if (pollCount === 1) {
        // Only the new-sha run is returned (pending), old success is filtered out
        return makeCiStatus("pending", [
          makeCiRun({
            status: "in_progress",
            conclusion: "",
            headSha: "new-sha",
          }),
        ]);
      }
      return makeCiStatus("pass", [
        makeCiRun({ conclusion: "success", headSha: "new-sha" }),
      ]);
    });

    const agent: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi.fn(),
    };

    const stage = createCiCheckStageHandler({
      agent,
      ...ISSUE_CTX,
      getCiStatus,
      getHeadSha,
      collectFailureLogs: vi.fn(),
      delay: vi.fn().mockResolvedValue(undefined),
    });

    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));

    expect(result.success).toBe(true);
    expect(pollCount).toBe(2);
    expect(agent.invoke).not.toHaveBeenCalled();
  });
});

// ---- Stage 6 through pipeline ----------------------------------------------

describe("Stage 6 (Test plan verification) through pipeline", () => {
  test("DONE on first check → pipeline completes", async () => {
    const verifyResult = makeResult({
      sessionId: "s1",
      responseText: "Verified.",
    });
    const doneResult = makeResult({ responseText: "DONE" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(verifyResult)),
      resume: vi.fn().mockReturnValue(makeStream(doneResult)),
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
        // 3-step flow: odd = work, even = verdict.
        if (resumeCalls % 2 === 1) {
          return makeStream(makeResult({ responseText: "Checked items." }));
        }
        if (resumeCalls < 5) {
          return makeStream(makeResult({ responseText: "FIXED" }));
        }
        return makeStream(makeResult({ responseText: "DONE" }));
      }),
    };

    const stage = createTestPlanStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));

    expect(result.success).toBe(true);
    expect(invokeCalls).toBe(3);
    expect(resumeCalls).toBe(6); // 3x(work+verdict)
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
        // 3-step flow: odd = work, even = verdict.
        if (resumeCalls % 2 === 1) {
          return makeStream(makeResult({ responseText: "Checked items." }));
        }
        if (resumeCalls <= 6) {
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

  test("error during self-check → user retries → completes next round", async () => {
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
          // Work step returns agent error on first round.
          return makeStream(
            makeResult({
              status: "error",
              errorType: "execution_error",
              stderrText: "timeout",
              responseText: "",
            }),
          );
        }
        // Subsequent rounds: work + verdict both succeed with DONE.
        return makeStream(makeResult({ responseText: "DONE" }));
      }),
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
      getHeadSha: stubGetHeadSha,
      emptyRunsGracePeriodMs: 0,
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

    let tpVerdictCalls = 0;
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
        // Test plan verdict follow-up (3-step: work + verdict)
        if (prompt.includes("finished the test plan verification pass")) {
          tpVerdictCalls++;
          if (tpVerdictCalls === 1) {
            return makeStream(makeResult({ responseText: "FIXED" }));
          }
          return makeStream(makeResult({ responseText: "DONE" }));
        }
        // Test plan self-check work prompt
        return makeStream(makeResult({ responseText: "Checked items." }));
      }),
    };

    const prStage = createCreatePrStageHandler({ agent, ...ISSUE_CTX });
    const ciStage = createCiCheckStageHandler({
      agent,
      ...ISSUE_CTX,
      getCiStatus,
      collectFailureLogs: vi.fn(),
      delay: vi.fn().mockResolvedValue(undefined),
      getHeadSha: stubGetHeadSha,
      emptyRunsGracePeriodMs: 0,
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
    expect(tpVerdictCalls).toBe(2);
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
      getHeadSha: stubGetHeadSha,
      emptyRunsGracePeriodMs: 0,
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
        // Self-check: work, verdict, issue sync, issue sync verdict
        scResumeCalls++;
        if (prompt.includes("Report what issue sync")) {
          return makeStream(makeResult({ responseText: "ISSUE_NO_CHANGES" }));
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
    expect(implInvokeCalls).toBe(1);
    expect(implResumeCalls).toBe(1);
    expect(scInvokeCalls).toBe(1);
    // 1 work + 1 verdict + 1 issue sync + 1 issue sync verdict
    expect(scResumeCalls).toBe(4);
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
        // 3-step self-check: odd = work, even = verdict.
        scResumeCalls++;
        if (prompt.includes("Report what issue sync")) {
          return makeStream(makeResult({ responseText: "ISSUE_NO_CHANGES" }));
        }
        if (scResumeCalls % 2 === 1) {
          return makeStream(makeResult({ responseText: "Applied fixes." }));
        }
        if (scResumeCalls <= 4) {
          // Verdict calls 2,4 = FIXED
          return makeStream(makeResult({ responseText: "FIXED" }));
        }
        // Even calls > 4: verdict DONE or issue sync work
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
    // 2 FIXED + 1 DONE: 3x(work+verdict) + issue sync + issue sync verdict
    expect(scResumeCalls).toBe(8);
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

// ---- Stage 8 (Squash) through pipeline ---------------------------------------

describe("Stage 8 (Squash) through pipeline", () => {
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
      defaultBranch: "main",
      countBranchCommits: () => 2,
      getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
      collectFailureLogs: vi.fn().mockReturnValue(""),
      delay: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 100,
      pollTimeoutMs: 1000,
      getHeadSha: stubGetHeadSha,
      emptyRunsGracePeriodMs: 0,
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
      defaultBranch: "main",
      countBranchCommits: () => 2,
      getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
      collectFailureLogs: vi.fn().mockReturnValue(""),
      delay: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 100,
      pollTimeoutMs: 1000,
      getHeadSha: stubGetHeadSha,
      emptyRunsGracePeriodMs: 0,
    });

    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );
    expect(result.success).toBe(false);
    expect(result.stoppedAt).toBe(8);
  });
});

describe("Stage 8 (Squash) baseSha integration", () => {
  test("squash prompt includes baseSha when context has it", async () => {
    let capturedPrompt = "";
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation((prompt: string) => {
        capturedPrompt = prompt;
        return makeStream(
          makeResult({ sessionId: "s1", responseText: "Squashed." }),
        );
      }),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };

    const stage = createSquashStageHandler({
      agent,
      ...ISSUE_CTX,
      defaultBranch: "main",
      countBranchCommits: () => 3,
      getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
      collectFailureLogs: vi.fn().mockReturnValue(""),
      delay: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 100,
      pollTimeoutMs: 1000,
      getHeadSha: stubGetHeadSha,
      emptyRunsGracePeriodMs: 0,
    });

    const ctx = { ...BASE_CTX, baseSha: "abc1234def567890" };
    await runPipeline(makePipelineOpts({ stages: [stage], context: ctx }));

    expect(capturedPrompt).toContain("abc1234def567890");
    expect(capturedPrompt).toContain("git reset --soft abc1234def567890");
  });

  test("squash prompt uses generic wording when baseSha is absent", async () => {
    let capturedPrompt = "";
    const agent: AgentAdapter = {
      invoke: vi.fn().mockImplementation((prompt: string) => {
        capturedPrompt = prompt;
        return makeStream(
          makeResult({ sessionId: "s1", responseText: "Squashed." }),
        );
      }),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };

    const stage = createSquashStageHandler({
      agent,
      ...ISSUE_CTX,
      defaultBranch: "main",
      countBranchCommits: () => 3,
      getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
      collectFailureLogs: vi.fn().mockReturnValue(""),
      delay: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 100,
      pollTimeoutMs: 1000,
      getHeadSha: stubGetHeadSha,
      emptyRunsGracePeriodMs: 0,
    });

    await runPipeline(makePipelineOpts({ stages: [stage] }));

    expect(capturedPrompt).toContain("Review all commits on this branch");
    expect(capturedPrompt).not.toContain("git reset --soft");
  });
});

// ---- Stage 7 (Review) through pipeline ---------------------------------------

describe("Stage 7 (Review) through pipeline", () => {
  test("completes when Agent B approves on first round", async () => {
    const agentA: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sa-fin",
            responseText: "PR body verified.",
          }),
        ),
      ),
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "PR_FINALIZED" })),
        ),
    };

    let bResumeCalls = 0;
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sb",
            responseText: "Looks good.",
          }),
        ),
      ),
      resume: vi.fn().mockImplementation(() => {
        bResumeCalls++;
        if (bResumeCalls === 1) {
          // Verdict follow-up
          return makeStream(makeResult({ responseText: "APPROVED" }));
        }
        // Unresolved summary + unresolved verdict
        return makeStream(makeResult({ responseText: "NONE" }));
      }),
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
      getHeadSha: stubGetHeadSha,
      emptyRunsGracePeriodMs: 0,
    });

    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));
    expect(result.success).toBe(true);
    expect(agentA.invoke).toHaveBeenCalledTimes(1);
  });

  test("NOT_APPROVED → fix → CI pass → loops → APPROVED: completes", async () => {
    let bInvokeCalls = 0;
    let bResumeCalls = 0;
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        bInvokeCalls++;
        return makeStream(
          makeResult({
            sessionId: `sb${bInvokeCalls}`,
            responseText: "Review posted.",
          }),
        );
      }),
      resume: vi.fn().mockImplementation(() => {
        bResumeCalls++;
        if (bResumeCalls === 1) {
          // Round 1 verdict: NOT_APPROVED
          return makeStream(makeResult({ responseText: "NOT_APPROVED" }));
        }
        if (bResumeCalls === 2) {
          // Round 2 verdict: APPROVED
          return makeStream(makeResult({ responseText: "APPROVED" }));
        }
        // Unresolved summary + verdict
        return makeStream(makeResult({ responseText: "NONE" }));
      }),
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
      resume: vi.fn().mockImplementation((_sid: string, prompt: string) => {
        if (prompt.includes("PR_FINALIZED")) {
          return makeStream(makeResult({ responseText: "PR_FINALIZED" }));
        }
        return makeStream(makeResult({ responseText: "COMPLETED" }));
      }),
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
      getHeadSha: stubGetHeadSha,
      emptyRunsGracePeriodMs: 0,
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
            responseText: "Review posted.",
          }),
        ),
      ),
      resume: vi.fn().mockImplementation((_sid: string, prompt: string) => {
        // Verdict follow-up → NOT_APPROVED
        if (prompt.includes("posted your review")) {
          return makeStream(makeResult({ responseText: "NOT_APPROVED" }));
        }
        // Unresolved summary + verdict
        return makeStream(makeResult({ responseText: "NONE" }));
      }),
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
        getHeadSha: stubGetHeadSha,
        emptyRunsGracePeriodMs: 0,
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
        return makeStream(
          makeResult({
            sessionId: `sb${bInvokeCalls}`,
            responseText: "Review posted.",
          }),
        );
      }),
      resume: vi.fn().mockImplementation((_sid: string, prompt: string) => {
        // Verdict follow-up
        if (prompt.includes("posted your review")) {
          if (bInvokeCalls <= 3) {
            return makeStream(makeResult({ responseText: "NOT_APPROVED" }));
          }
          return makeStream(makeResult({ responseText: "APPROVED" }));
        }
        // Unresolved summary + verdict
        return makeStream(makeResult({ responseText: "NONE" }));
      }),
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
      resume: vi.fn().mockImplementation((_sid: string, prompt: string) => {
        if (prompt.includes("PR_FINALIZED")) {
          return makeStream(makeResult({ responseText: "PR_FINALIZED" }));
        }
        return makeStream(makeResult({ responseText: "COMPLETED" }));
      }),
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
        getHeadSha: stubGetHeadSha,
        emptyRunsGracePeriodMs: 0,
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

  test("budget-exhausted NOT_APPROVED round includes unresolved summary", async () => {
    let bInvokeCalls = 0;
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        bInvokeCalls++;
        return makeStream(
          makeResult({
            sessionId: `sb${bInvokeCalls}`,
            responseText: "Review posted.",
          }),
        );
      }),
      resume: vi.fn().mockImplementation((_sid: string, prompt: string) => {
        // Review verdict follow-up
        if (prompt.includes("posted your review")) {
          return makeStream(makeResult({ responseText: "NOT_APPROVED" }));
        }
        // Unresolved summary work step (contains "review cycle")
        if (prompt.includes("review cycle")) {
          return makeStream(
            makeResult({
              responseText:
                "**[Reviewer Unresolved Round 3]**\n- Missing error handling in parser",
            }),
          );
        }
        // Unresolved verdict follow-up or clarification
        return makeStream(makeResult({ responseText: "COMPLETED" }));
      }),
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
        getHeadSha: stubGetHeadSha,
        emptyRunsGracePeriodMs: 0,
      }),
      autoBudget: 3,
    };

    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );
    expect(result.success).toBe(false);
    expect(prompt.confirmContinueLoop).toHaveBeenCalled();

    // Agent B resumed: 3 verdict follow-ups + unresolved summary +
    // unresolved verdict on round 3 (lastAutoIteration).
    // Rounds 1-2 only have verdict follow-up, round 3 adds unresolved.
    expect(agentB.resume).toHaveBeenCalledTimes(5);

    // The unresolved summary must reach the user via confirmContinueLoop.
    expect(prompt.confirmContinueLoop).toHaveBeenCalledWith(
      "Review",
      3,
      expect.stringContaining("Missing error handling in parser"),
    );
  });

  test("non-final NOT_APPROVED rounds do not request unresolved summary", async () => {
    let bInvokeCalls = 0;
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockImplementation(() => {
        bInvokeCalls++;
        return makeStream(
          makeResult({
            sessionId: `sb${bInvokeCalls}`,
            responseText: "Review posted.",
          }),
        );
      }),
      resume: vi.fn().mockImplementation((_sid: string, prompt: string) => {
        // Verdict follow-up — return a session ID that advances
        // beyond the invoke session, so we can verify the
        // unresolved summary resumes the verdict session.
        if (prompt.includes("posted your review")) {
          if (bInvokeCalls <= 2) {
            return makeStream(
              makeResult({
                sessionId: `sb${bInvokeCalls}-v`,
                responseText: "NOT_APPROVED",
              }),
            );
          }
          return makeStream(
            makeResult({
              sessionId: `sb${bInvokeCalls}-v`,
              responseText: "APPROVED",
            }),
          );
        }
        // Unresolved summary + verdict
        return makeStream(makeResult({ responseText: "NONE" }));
      }),
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
      resume: vi.fn().mockImplementation((_sid: string, prompt: string) => {
        if (prompt.includes("PR_FINALIZED")) {
          return makeStream(makeResult({ responseText: "PR_FINALIZED" }));
        }
        return makeStream(makeResult({ responseText: "COMPLETED" }));
      }),
    };

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
        getHeadSha: stubGetHeadSha,
        emptyRunsGracePeriodMs: 0,
      }),
      autoBudget: 3,
    };

    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));
    expect(result.success).toBe(true);

    // Agent B resumed: 2 verdict follow-ups (NOT_APPROVED, rounds 1-2) +
    // 1 verdict follow-up (APPROVED, round 3) + unresolved summary + verdict.
    // Rounds 1-2 do NOT trigger unresolved summary (not lastAutoIteration).
    expect(agentB.resume).toHaveBeenCalledTimes(5);
    // The unresolved summary call should use the verdict session ID
    // ("sb3-v"), not the initial review invoke session ("sb3").
    expect(agentB.resume).toHaveBeenCalledWith(
      "sb3-v",
      expect.stringContaining("unresolved"),
      { cwd: "/tmp/wt" },
    );
  });

  test("CI error during fix flow → pipeline aborts", async () => {
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sb",
            responseText: "Review posted.",
          }),
        ),
      ),
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "NOT_APPROVED" })),
        ),
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
      getHeadSha: stubGetHeadSha,
      emptyRunsGracePeriodMs: 0,
    });

    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );
    expect(result.success).toBe(false);
  });
});

// ---- Stages 7+8 combined through pipeline ------------------------------------

describe("Stages 7+8 (Review + Squash) through pipeline", () => {
  test("review approves → squash succeeds → CI passes: pipeline completes", async () => {
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
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sa-fin",
            responseText: "PR body verified.",
          }),
        ),
      ),
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "PR_FINALIZED" })),
        ),
    };

    let bResumeCalls = 0;
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sb",
            responseText: "Looks good.",
          }),
        ),
      ),
      resume: vi.fn().mockImplementation(() => {
        bResumeCalls++;
        if (bResumeCalls === 1) {
          return makeStream(makeResult({ responseText: "APPROVED" }));
        }
        return makeStream(makeResult({ responseText: "NONE" }));
      }),
    };

    const getCiStatus = vi.fn().mockReturnValue(makeCiStatus("pass"));

    const squashStage = createSquashStageHandler({
      agent: squashAgent,
      ...ISSUE_CTX,
      defaultBranch: "main",
      countBranchCommits: () => 2,
      getCiStatus,
      collectFailureLogs: vi.fn().mockReturnValue(""),
      delay: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 100,
      pollTimeoutMs: 1000,
      getHeadSha: stubGetHeadSha,
      emptyRunsGracePeriodMs: 0,
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
      getHeadSha: stubGetHeadSha,
      emptyRunsGracePeriodMs: 0,
    });

    const result = await runPipeline(
      makePipelineOpts({ stages: [reviewStage, squashStage] }),
    );
    expect(result.success).toBe(true);
    expect(agentB.invoke).toHaveBeenCalledTimes(1);
    expect(squashAgent.invoke).toHaveBeenCalledTimes(1);
    expect(agentA.invoke).toHaveBeenCalledTimes(1);
  });

  test("squash blocked → pipeline aborts after review", async () => {
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

    let bResumeCalls = 0;
    const agentB: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sb",
            responseText: "Looks good.",
          }),
        ),
      ),
      resume: vi.fn().mockImplementation(() => {
        bResumeCalls++;
        if (bResumeCalls === 1) {
          return makeStream(makeResult({ responseText: "APPROVED" }));
        }
        return makeStream(makeResult({ responseText: "NONE" }));
      }),
    };

    const prompt = makePrompt({
      handleBlocked: vi.fn().mockResolvedValue({ action: "halt" }),
    });

    const squashStage = createSquashStageHandler({
      agent: squashAgent,
      ...ISSUE_CTX,
      defaultBranch: "main",
      countBranchCommits: () => 2,
      getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
      collectFailureLogs: vi.fn().mockReturnValue(""),
      delay: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 100,
      pollTimeoutMs: 1000,
      getHeadSha: stubGetHeadSha,
      emptyRunsGracePeriodMs: 0,
    });

    const reviewAgentA: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sa-fin",
            responseText: "PR body verified.",
          }),
        ),
      ),
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "PR_FINALIZED" })),
        ),
    };

    const reviewStage = createReviewStageHandler({
      agentA: reviewAgentA,
      agentB,
      ...ISSUE_CTX,
      getCiStatus: vi.fn().mockReturnValue(makeCiStatus("pass")),
      collectFailureLogs: vi.fn().mockReturnValue(""),
      delay: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 100,
      pollTimeoutMs: 1000,
      getHeadSha: stubGetHeadSha,
      emptyRunsGracePeriodMs: 0,
    });

    const result = await runPipeline(
      makePipelineOpts({ stages: [reviewStage, squashStage], prompt }),
    );
    expect(result.success).toBe(false);
    expect(result.stoppedAt).toBe(8);
    expect(agentB.invoke).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Pipeline event emitter integration
// ---------------------------------------------------------------------------

describe("Pipeline event emitter integration", () => {
  test("emits stage:enter and stage:exit events during pipeline run", async () => {
    const implResult = makeResult({ sessionId: "s1", responseText: "Done." });
    const checkResult = makeResult({ responseText: "COMPLETED" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(implResult)),
      resume: vi.fn().mockReturnValue(makeStream(checkResult)),
    };

    const emitter = new PipelineEventEmitter();
    const enterEvents: StageEnterEvent[] = [];
    const exitEvents: StageExitEvent[] = [];
    emitter.on("stage:enter", (ev) => enterEvents.push(ev));
    emitter.on("stage:exit", (ev) => exitEvents.push(ev));

    const stage = createImplementStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], events: emitter }),
    );

    expect(result.success).toBe(true);
    expect(enterEvents).toEqual([
      { stageNumber: 2, stageName: "Implement", iteration: 0 },
    ]);
    expect(exitEvents).toEqual([{ stageNumber: 2, outcome: "completed" }]);
  });

  test("emits agent:chunk events when sink is wired through stage handler", async () => {
    const implResult = makeResult({ sessionId: "s1", responseText: "Done." });
    const checkResult = makeResult({ responseText: "COMPLETED" });
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStreamWithChunks(implResult, ["chunk-a1", "chunk-a2"]),
        ),
      resume: vi.fn().mockReturnValue(makeStream(checkResult)),
    };

    const emitter = new PipelineEventEmitter();
    const chunkEvents: AgentChunkEvent[] = [];
    emitter.on("agent:chunk", (ev) => chunkEvents.push(ev));

    const stage = createImplementStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], events: emitter }),
    );

    expect(result.success).toBe(true);
    expect(chunkEvents.length).toBe(2);
    expect(chunkEvents[0]).toEqual({ agent: "a", chunk: "chunk-a1" });
    expect(chunkEvents[1]).toEqual({ agent: "a", chunk: "chunk-a2" });
  });

  test("emits stage events for multi-stage pipeline", async () => {
    const implResult = makeResult({ sessionId: "s1", responseText: "ok" });
    const implCheck = makeResult({ responseText: "COMPLETED" });
    const selfResult = makeResult({ sessionId: "s2", responseText: "ok" });
    const selfWork = makeResult({ responseText: "All good." });
    const selfDone = makeResult({ responseText: "DONE" });
    const syncVerdict = makeResult({ responseText: "ISSUE_NO_CHANGES" });

    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValueOnce(makeStream(implResult))
        .mockReturnValueOnce(makeStream(selfResult)),
      resume: vi
        .fn()
        .mockReturnValueOnce(makeStream(implCheck))
        // Self-check: work + verdict + issue sync + issue sync verdict
        .mockReturnValueOnce(makeStream(selfWork))
        .mockReturnValueOnce(makeStream(selfDone))
        .mockReturnValueOnce(makeStream(selfDone))
        .mockReturnValueOnce(makeStream(syncVerdict)),
    };

    const emitter = new PipelineEventEmitter();
    const enterEvents: StageEnterEvent[] = [];
    emitter.on("stage:enter", (ev) => enterEvents.push(ev));

    const stages = [
      createImplementStageHandler({ agent, ...ISSUE_CTX }),
      createSelfCheckStageHandler({ agent, ...ISSUE_CTX }),
    ];
    const result = await runPipeline(
      makePipelineOpts({ stages, events: emitter }),
    );

    expect(result.success).toBe(true);
    expect(enterEvents).toEqual([
      { stageNumber: 2, stageName: "Implement", iteration: 0 },
      { stageNumber: 3, stageName: "Self-check", iteration: 0 },
    ]);
  });

  test("no events emitted when events option is omitted", async () => {
    const implResult = makeResult({ sessionId: "s1", responseText: "Done." });
    const checkResult = makeResult({ responseText: "COMPLETED" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(implResult)),
      resume: vi.fn().mockReturnValue(makeStream(checkResult)),
    };

    // No emitter passed — should not throw.
    const stage = createImplementStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));

    expect(result.success).toBe(true);
  });

  test("review stage emits chunks for agent B on sink b", async () => {
    const reviewResult = makeResult({
      sessionId: "sb1",
      responseText: "Looks good.",
    });

    const agentA: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            sessionId: "sa-fin",
            responseText: "PR body verified.",
          }),
        ),
      ),
      resume: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "PR_FINALIZED" })),
        ),
    };

    let bResumeCalls = 0;
    const agentB: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStreamWithChunks(reviewResult, ["review-b1", "review-b2"]),
        ),
      resume: vi.fn().mockImplementation(() => {
        bResumeCalls++;
        if (bResumeCalls === 1) {
          return makeStream(makeResult({ responseText: "APPROVED" }));
        }
        return makeStream(makeResult({ responseText: "NONE" }));
      }),
    };

    const emitter = new PipelineEventEmitter();
    const chunkEvents: AgentChunkEvent[] = [];
    emitter.on("agent:chunk", (ev) => chunkEvents.push(ev));

    const stage = createReviewStageHandler({
      agentA,
      agentB,
      ...ISSUE_CTX,
    });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], events: emitter }),
    );

    expect(result.success).toBe(true);
    const agentBChunks = chunkEvents.filter((e) => e.agent === "b");
    expect(agentBChunks.length).toBe(2);
    expect(agentBChunks[0].chunk).toBe("review-b1");
  });

  test("emits stage:enter on each iteration when self-check loops", async () => {
    // Self-check returns FIXED twice (not_approved → loop), then DONE.
    const implResult = makeResult({ sessionId: "s1", responseText: "ok" });
    const implCheck = makeResult({ responseText: "COMPLETED" });

    const selfResult1 = makeResult({ sessionId: "s2", responseText: "ok" });
    const selfWork = makeResult({ responseText: "Applied fixes." });
    const selfFixed = makeResult({ responseText: "FIXED" });
    const selfResult2 = makeResult({ sessionId: "s3", responseText: "ok" });
    const selfResult3 = makeResult({ sessionId: "s4", responseText: "ok" });
    const selfDoneResult = makeResult({ responseText: "DONE" });
    const syncVerdictResult = makeResult({ responseText: "ISSUE_NO_CHANGES" });

    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValueOnce(makeStream(implResult))
        .mockReturnValueOnce(makeStream(selfResult1))
        .mockReturnValueOnce(makeStream(selfResult2))
        .mockReturnValueOnce(makeStream(selfResult3)),
      resume: vi
        .fn()
        // Stage 2: completion check
        .mockReturnValueOnce(makeStream(implCheck))
        // Stage 3, iteration 0: work + verdict FIXED
        .mockReturnValueOnce(makeStream(selfWork))
        .mockReturnValueOnce(makeStream(selfFixed))
        // Stage 3, iteration 1: work + verdict FIXED
        .mockReturnValueOnce(makeStream(selfWork))
        .mockReturnValueOnce(makeStream(selfFixed))
        // Stage 3, iteration 2: work + verdict DONE + issue sync + verdict
        .mockReturnValueOnce(makeStream(selfWork))
        .mockReturnValueOnce(makeStream(selfDoneResult))
        .mockReturnValueOnce(makeStream(selfDoneResult))
        .mockReturnValueOnce(makeStream(syncVerdictResult)),
    };

    const emitter = new PipelineEventEmitter();
    const enterEvents: StageEnterEvent[] = [];
    const exitEvents: StageExitEvent[] = [];
    emitter.on("stage:enter", (ev) => enterEvents.push(ev));
    emitter.on("stage:exit", (ev) => exitEvents.push(ev));

    const stages = [
      createImplementStageHandler({ agent, ...ISSUE_CTX }),
      createSelfCheckStageHandler({ agent, ...ISSUE_CTX }),
    ];
    const result = await runPipeline(
      makePipelineOpts({ stages, events: emitter }),
    );

    expect(result.success).toBe(true);

    // Implement: 1 enter + 1 exit.
    // Self-check: 3 iterations (0,1,2) → 3 enter + 3 exit.
    const selfEnterEvents = enterEvents.filter((e) => e.stageNumber === 3);
    expect(selfEnterEvents).toEqual([
      { stageNumber: 3, stageName: "Self-check", iteration: 0 },
      { stageNumber: 3, stageName: "Self-check", iteration: 1 },
      { stageNumber: 3, stageName: "Self-check", iteration: 2 },
    ]);

    const selfExitEvents = exitEvents.filter((e) => e.stageNumber === 3);
    expect(selfExitEvents).toEqual([
      { stageNumber: 3, outcome: "not_approved" },
      { stageNumber: 3, outcome: "not_approved" },
      { stageNumber: 3, outcome: "completed" },
    ]);
  });

  test("event ordering: enter-exit pairs interleave correctly across stages", async () => {
    const implResult = makeResult({ sessionId: "s1", responseText: "ok" });
    const implCheck = makeResult({ responseText: "COMPLETED" });
    const selfResult = makeResult({ sessionId: "s2", responseText: "ok" });
    const selfWork = makeResult({ responseText: "All good." });
    const selfDoneEvt = makeResult({ responseText: "DONE" });
    const syncVerdictEvt = makeResult({ responseText: "ISSUE_NO_CHANGES" });

    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValueOnce(makeStream(implResult))
        .mockReturnValueOnce(makeStream(selfResult)),
      resume: vi
        .fn()
        .mockReturnValueOnce(makeStream(implCheck))
        // Self-check: work + verdict + issue sync + issue sync verdict
        .mockReturnValueOnce(makeStream(selfWork))
        .mockReturnValueOnce(makeStream(selfDoneEvt))
        .mockReturnValueOnce(makeStream(selfDoneEvt))
        .mockReturnValueOnce(makeStream(syncVerdictEvt)),
    };

    const emitter = new PipelineEventEmitter();
    const timeline: string[] = [];
    emitter.on("stage:enter", (ev) => timeline.push(`enter:${ev.stageNumber}`));
    emitter.on("stage:exit", (ev) =>
      timeline.push(`exit:${ev.stageNumber}:${ev.outcome}`),
    );

    const stages = [
      createImplementStageHandler({ agent, ...ISSUE_CTX }),
      createSelfCheckStageHandler({ agent, ...ISSUE_CTX }),
    ];
    await runPipeline(makePipelineOpts({ stages, events: emitter }));

    expect(timeline).toEqual([
      "enter:2",
      "exit:2:completed",
      "enter:3",
      "exit:3:completed",
    ]);
  });
});

// ---- Streaming: agent:chunk events during stage execution --------------------

describe("agent:chunk events emitted during stage execution", () => {
  test("implement stage emits agent:chunk events for both invoke and follow-up", async () => {
    const implResult = makeResult({ sessionId: "s1", responseText: "impl" });
    const checkResult = makeResult({ responseText: "COMPLETED" });
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStreamWithChunks(implResult, ["impl-c1", "impl-c2"]),
        ),
      resume: vi
        .fn()
        .mockReturnValue(
          makeStreamWithChunks(checkResult, ["check-c1", "check-c2"]),
        ),
    };

    const emitter = new PipelineEventEmitter();
    const agentChunks: AgentChunkEvent[] = [];
    emitter.on("agent:chunk", (ev) => agentChunks.push({ ...ev }));

    const stage = createImplementStageHandler({ agent, ...ISSUE_CTX });
    await runPipeline(makePipelineOpts({ stages: [stage], events: emitter }));

    // All chunks should be tagged as agent "a".
    expect(agentChunks.length).toBeGreaterThanOrEqual(2);
    for (const ev of agentChunks) {
      expect(ev.agent).toBe("a");
    }
    // Verify content includes chunks from both invoke and resume.
    const allText = agentChunks.map((e) => e.chunk).join("");
    expect(allText).toContain("impl-c1");
    expect(allText).toContain("check-c1");
  });

  test("review stage emits chunks for both agent A and agent B", async () => {
    // Agent B reviews, Agent A fixes, Agent A self-checks.
    const reviewResult = makeResult({
      sessionId: "sb1",
      responseText: "APPROVED",
    });
    const agentA: AgentAdapter = {
      invoke: vi.fn(),
      resume: vi.fn(),
    };
    const agentB: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(makeStreamWithChunks(reviewResult, ["review-chunk"])),
      resume: vi.fn(),
    };

    const emitter = new PipelineEventEmitter();
    const seenAgents = new Set<string>();
    emitter.on("agent:chunk", (ev) => seenAgents.add(ev.agent));

    const stage = createReviewStageHandler({
      agentA,
      agentB,
      ...ISSUE_CTX,
    });
    await runPipeline(makePipelineOpts({ stages: [stage], events: emitter }));

    // At minimum, agent B chunks should appear (reviewer).
    expect(seenAgents.has("b")).toBe(true);
  });

  test("stage:enter fires before agent:chunk, stage:exit fires after", async () => {
    const implResult = makeResult({ sessionId: "s1", responseText: "ok" });
    const checkResult = makeResult({ responseText: "COMPLETED" });
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStreamWithChunks(implResult, ["c1"])),
      resume: vi
        .fn()
        .mockReturnValue(makeStreamWithChunks(checkResult, ["c2"])),
    };

    const emitter = new PipelineEventEmitter();
    const timeline: string[] = [];
    emitter.on("stage:enter", (ev) => timeline.push(`enter:${ev.stageNumber}`));
    emitter.on("agent:chunk", () => timeline.push("chunk"));
    emitter.on("stage:exit", (ev) => timeline.push(`exit:${ev.stageNumber}`));

    const stage = createImplementStageHandler({ agent, ...ISSUE_CTX });
    await runPipeline(makePipelineOpts({ stages: [stage], events: emitter }));

    // Enter must come before any chunk, exit must come after handler returns.
    const enterIdx = timeline.indexOf("enter:2");
    const firstChunkIdx = timeline.indexOf("chunk");
    const exitIdx = timeline.indexOf("exit:2");

    expect(enterIdx).toBeLessThan(firstChunkIdx);
    expect(firstChunkIdx).toBeLessThan(exitIdx);
  });
});

// ---- Inactivity timeout → auto-resume through pipeline ----------------------

describe("Inactivity timeout auto-resume through pipeline", () => {
  test("implement stage auto-resumes on timeout and completes", async () => {
    // First invoke: returns successfully (implementation phase).
    // First resume (completion check): times out.
    // Auto-resume: succeeds with COMPLETED.
    const implResult = makeResult({ sessionId: "s1", responseText: "Done." });
    const timeoutResult = makeResult({
      sessionId: "s1",
      status: "error",
      errorType: "inactivity_timeout",
    });
    const completedResult = makeResult({ responseText: "COMPLETED" });

    let resumeCount = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(implResult)),
      resume: vi.fn().mockImplementation(() => {
        resumeCount++;
        if (resumeCount === 1) {
          // First resume = completion check → timeout.
          return makeStream(timeoutResult);
        }
        // Second resume = auto-resume after timeout → success.
        return makeStream(completedResult);
      }),
    };

    const stage = createImplementStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(makePipelineOpts({ stages: [stage] }));

    expect(result.success).toBe(true);
    // invoke(1) + resume for completion check(1) + auto-resume(1) = 2 resumes
    expect(agent.resume).toHaveBeenCalledTimes(2);
  });

  test("timeout exhausts retries → pipeline error → user aborts", async () => {
    const implResult = makeResult({ sessionId: "s1", responseText: "Done." });
    const timeoutResult = makeResult({
      sessionId: "s1",
      status: "error",
      errorType: "inactivity_timeout",
    });

    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(implResult)),
      resume: vi.fn().mockReturnValue(makeStream(timeoutResult)),
    };
    const prompt = makePrompt({
      handleError: vi.fn().mockResolvedValue({ action: "abort" }),
    });

    const stage = createImplementStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(false);
    expect(result.stoppedAt).toBe(2);
    // Error handler should have been called once.
    expect(prompt.handleError).toHaveBeenCalledOnce();
    const errorMsg = (prompt.handleError as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(errorMsg).toContain("inactivity");
  });

  test("timeout exhausts retries → user retries → succeeds", async () => {
    const implResult = makeResult({ sessionId: "s1", responseText: "Done." });
    const timeoutResult = makeResult({
      sessionId: "s1",
      status: "error",
      errorType: "inactivity_timeout",
    });
    const completedResult = makeResult({ responseText: "COMPLETED" });

    let totalResumes = 0;
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(makeStream(implResult)),
      resume: vi.fn().mockImplementation(() => {
        totalResumes++;
        // First 4 resumes time out (completion check + 3 auto-retries).
        // After user retries the stage, the 5th resume succeeds.
        if (totalResumes <= 4) {
          return makeStream(timeoutResult);
        }
        return makeStream(completedResult);
      }),
    };
    const prompt = makePrompt({
      handleError: vi.fn().mockResolvedValueOnce({ action: "retry" }),
    });

    const stage = createImplementStageHandler({ agent, ...ISSUE_CTX });
    const result = await runPipeline(
      makePipelineOpts({ stages: [stage], prompt }),
    );

    expect(result.success).toBe(true);
    // invoke was called twice (first attempt + retry after user approval).
    expect(agent.invoke).toHaveBeenCalledTimes(2);
  });
});
