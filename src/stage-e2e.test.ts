/**
 * E2E tests for stages 2 and 3 running through the pipeline engine.
 *
 * These tests verify that the stage handlers integrate correctly with
 * pipeline loop control, blocked/error handling, and multi-stage flows.
 */

import { describe, expect, test, vi } from "vitest";
import type { AgentAdapter, AgentResult, AgentStream } from "./agent.js";
import type {
  PipelineOptions,
  StageContext,
  UserAction,
  UserPrompt,
} from "./pipeline.js";
import { runPipeline } from "./pipeline.js";
import { createImplementStageHandler } from "./stage-implement.js";
import { createSelfCheckStageHandler } from "./stage-selfcheck.js";

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

// ---- Multi-stage E2E -------------------------------------------------------

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
