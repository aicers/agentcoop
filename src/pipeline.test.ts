import { describe, expect, test, vi } from "vitest";
import type {
  PipelineOptions,
  StageContext,
  StageDefinition,
  StageResult,
  UserAction,
  UserPrompt,
} from "./pipeline.js";
import {
  advanceLoop,
  createDoneStageHandler,
  createLoopControl,
  grantLoopBudget,
  isTerminalSuccess,
  runPipeline,
} from "./pipeline.js";
import { buildClarificationPrompt } from "./step-parser.js";

// ---- helpers -------------------------------------------------------------

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

function makeStage(
  number: number,
  handler: (ctx: StageContext) => Promise<StageResult>,
  opts: Partial<StageDefinition> = {},
): StageDefinition {
  return {
    name: `Stage ${number}`,
    number,
    handler,
    ...opts,
  };
}

const BASE_CTX: Omit<StageContext, "iteration" | "userInstruction"> = {
  owner: "org",
  repo: "repo",
  issueNumber: 5,
  branch: "issue-5",
  worktreePath: "/tmp/wt",
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

// ---------------------------------------------------------------------------
// Loop control
// ---------------------------------------------------------------------------
describe("createLoopControl", () => {
  test("starts at iteration 0 with budget 3", () => {
    const lc = createLoopControl();
    expect(lc.iteration).toBe(0);
    expect(lc.autoRemaining).toBe(3);
    expect(lc.budget).toBe(3);
  });

  test("accepts custom budget", () => {
    const lc = createLoopControl(5);
    expect(lc.iteration).toBe(0);
    expect(lc.autoRemaining).toBe(5);
    expect(lc.budget).toBe(5);
  });
});

describe("advanceLoop", () => {
  test("decrements remaining and increments iteration", () => {
    const lc = createLoopControl();
    const canContinue = advanceLoop(lc);
    expect(lc.iteration).toBe(1);
    expect(lc.autoRemaining).toBe(2);
    expect(canContinue).toBe(true);
  });

  test("returns false when budget exhausted", () => {
    const lc = createLoopControl();
    advanceLoop(lc); // remaining: 2
    advanceLoop(lc); // remaining: 1
    const canContinue = advanceLoop(lc); // remaining: 0
    expect(canContinue).toBe(false);
    expect(lc.iteration).toBe(3);
  });

  test("returns true while budget remains", () => {
    const lc = createLoopControl();
    expect(advanceLoop(lc)).toBe(true); // 2 left
    expect(advanceLoop(lc)).toBe(true); // 1 left
    expect(advanceLoop(lc)).toBe(false); // 0 left
  });
});

describe("grantLoopBudget", () => {
  test("resets autoRemaining to budget", () => {
    const lc = createLoopControl();
    advanceLoop(lc);
    advanceLoop(lc);
    advanceLoop(lc);
    expect(lc.autoRemaining).toBe(0);
    grantLoopBudget(lc);
    expect(lc.autoRemaining).toBe(3);
  });

  test("resets autoRemaining to custom budget", () => {
    const lc = createLoopControl(5);
    for (let i = 0; i < 5; i++) advanceLoop(lc);
    expect(lc.autoRemaining).toBe(0);
    grantLoopBudget(lc);
    expect(lc.autoRemaining).toBe(5);
  });

  test("preserves iteration count", () => {
    const lc = createLoopControl();
    advanceLoop(lc);
    advanceLoop(lc);
    advanceLoop(lc);
    grantLoopBudget(lc);
    expect(lc.iteration).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// isTerminalSuccess
// ---------------------------------------------------------------------------
describe("isTerminalSuccess", () => {
  test("completed is terminal", () => {
    expect(isTerminalSuccess("completed")).toBe(true);
  });

  test("fixed is terminal", () => {
    expect(isTerminalSuccess("fixed")).toBe(true);
  });

  test("approved is terminal", () => {
    expect(isTerminalSuccess("approved")).toBe(true);
  });

  test("not_approved is not terminal", () => {
    expect(isTerminalSuccess("not_approved")).toBe(false);
  });

  test("blocked is not terminal", () => {
    expect(isTerminalSuccess("blocked")).toBe(false);
  });

  test("error is not terminal", () => {
    expect(isTerminalSuccess("error")).toBe(false);
  });

  test("needs_clarification is not terminal", () => {
    expect(isTerminalSuccess("needs_clarification")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runPipeline — basic flow
// ---------------------------------------------------------------------------
describe("runPipeline — basic flow", () => {
  test("runs stages in order and succeeds", async () => {
    const order: number[] = [];
    const stages = [
      makeStage(2, async () => {
        order.push(2);
        return { outcome: "completed", message: "done" };
      }),
      makeStage(1, async () => {
        order.push(1);
        return { outcome: "completed", message: "done" };
      }),
    ];
    const result = await runPipeline(makePipelineOpts({ stages }));
    expect(result.success).toBe(true);
    expect(order).toEqual([1, 2]); // sorted by stage number
  });

  test("returns success with no stages", async () => {
    const result = await runPipeline(makePipelineOpts());
    expect(result.success).toBe(true);
  });

  test("passes context to handler", async () => {
    let captured: StageContext | undefined;
    const stages = [
      makeStage(1, async (ctx) => {
        captured = ctx;
        return { outcome: "completed", message: "" };
      }),
    ];
    await runPipeline(makePipelineOpts({ stages }));
    expect(captured?.owner).toBe("org");
    expect(captured?.repo).toBe("repo");
    expect(captured?.issueNumber).toBe(5);
    expect(captured?.branch).toBe("issue-5");
    expect(captured?.iteration).toBe(0);
    expect(captured?.userInstruction).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runPipeline — step mode
// ---------------------------------------------------------------------------
describe("runPipeline — step mode", () => {
  test("asks user before each stage", async () => {
    const prompt = makePrompt();
    const stages = [
      makeStage(1, async () => ({ outcome: "completed", message: "" })),
      makeStage(2, async () => ({ outcome: "completed", message: "" })),
    ];
    await runPipeline(makePipelineOpts({ mode: "step", stages, prompt }));
    expect(prompt.confirmNextStage).toHaveBeenCalledTimes(2);
  });

  test("stops when user declines a stage", async () => {
    const prompt = makePrompt({
      confirmNextStage: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
    });
    const stages = [
      makeStage(1, async () => ({ outcome: "completed", message: "" })),
      makeStage(2, async () => ({ outcome: "completed", message: "" })),
    ];
    const result = await runPipeline(
      makePipelineOpts({ mode: "step", stages, prompt }),
    );
    expect(result.success).toBe(false);
    expect(result.stoppedAt).toBe(2);
  });

  test("does not ask in auto mode", async () => {
    const prompt = makePrompt();
    const stages = [
      makeStage(1, async () => ({ outcome: "completed", message: "" })),
    ];
    await runPipeline(makePipelineOpts({ mode: "auto", stages, prompt }));
    expect(prompt.confirmNextStage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runPipeline — loop control
// ---------------------------------------------------------------------------
describe("runPipeline — loop control", () => {
  test("uses custom per-stage autoBudget when provided", async () => {
    let calls = 0;
    const prompt = makePrompt({
      confirmContinueLoop: vi.fn().mockResolvedValue(false),
    });
    const stages = [
      makeStage(
        1,
        async () => {
          calls++;
          return { outcome: "not_approved", message: "try again" };
        },
        { autoBudget: 5 },
      ),
    ];
    await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(calls).toBe(5);
    expect(prompt.confirmContinueLoop).toHaveBeenCalledTimes(1);
  });

  test("custom per-stage autoBudget is preserved after grant", async () => {
    let calls = 0;
    const prompt = makePrompt({
      confirmContinueLoop: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValue(false),
    });
    const stages = [
      makeStage(
        1,
        async () => {
          calls++;
          return { outcome: "not_approved", message: "try again" };
        },
        { autoBudget: 2 },
      ),
    ];
    await runPipeline(makePipelineOpts({ stages, prompt }));
    // 2 auto + user approves + 2 more auto + user declines = 4
    expect(calls).toBe(4);
    expect(prompt.confirmContinueLoop).toHaveBeenCalledTimes(2);
  });

  test("loops up to 3 times automatically then asks user", async () => {
    let calls = 0;
    const prompt = makePrompt({
      confirmContinueLoop: vi.fn().mockResolvedValue(false),
    });
    const stages = [
      makeStage(1, async () => {
        calls++;
        return { outcome: "not_approved", message: "try again" };
      }),
    ];
    await runPipeline(makePipelineOpts({ stages, prompt }));
    // 3 auto iterations (budget used up), then user asked, declines.
    expect(calls).toBe(3);
    expect(prompt.confirmContinueLoop).toHaveBeenCalledTimes(1);
  });

  test("grants 3 more iterations when user approves", async () => {
    let calls = 0;
    const prompt = makePrompt({
      confirmContinueLoop: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValue(false),
    });
    const stages = [
      makeStage(1, async () => {
        calls++;
        return { outcome: "not_approved", message: "try again" };
      }),
    ];
    await runPipeline(makePipelineOpts({ stages, prompt }));
    // 3 auto + user approves + 3 more auto + user declines = 6
    expect(calls).toBe(6);
    expect(prompt.confirmContinueLoop).toHaveBeenCalledTimes(2);
  });

  test("exits loop early on terminal success", async () => {
    let calls = 0;
    const stages = [
      makeStage(1, async () => {
        calls++;
        if (calls === 2) {
          return { outcome: "completed", message: "done" };
        }
        return { outcome: "not_approved", message: "nope" };
      }),
    ];
    const result = await runPipeline(makePipelineOpts({ stages }));
    expect(result.success).toBe(true);
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// runPipeline — blocked handling
// ---------------------------------------------------------------------------
describe("runPipeline — blocked handling", () => {
  test("halts when user chooses halt on blocked", async () => {
    const prompt = makePrompt({
      handleBlocked: vi.fn().mockResolvedValue({ action: "halt" }),
    });
    const stages = [
      makeStage(1, async () => ({
        outcome: "blocked",
        message: "stuck",
      })),
    ];
    const result = await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(result.success).toBe(false);
    expect(result.stoppedAt).toBe(1);
  });

  test("proceeds when user chooses proceed (non-artifact stage)", async () => {
    const prompt = makePrompt({
      handleBlocked: vi.fn().mockResolvedValue({ action: "proceed" }),
    });
    const stages = [
      makeStage(1, async () => ({
        outcome: "blocked",
        message: "stuck",
      })),
      makeStage(2, async () => ({ outcome: "completed", message: "" })),
    ];
    const result = await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(result.success).toBe(true);
    expect(prompt.handleBlocked).toHaveBeenCalledWith("stuck", true);
  });

  test("passes allowProceed=false for requiresArtifact stages", async () => {
    const prompt = makePrompt({
      handleBlocked: vi.fn().mockResolvedValue({ action: "halt" }),
    });
    const stages = [
      makeStage(1, async () => ({ outcome: "blocked", message: "no PR" }), {
        requiresArtifact: true,
      }),
    ];
    await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(prompt.handleBlocked).toHaveBeenCalledWith("no PR", false);
  });

  test("continues with instruction when user chooses instruct", async () => {
    let receivedInstruction: string | undefined;
    const prompt = makePrompt({
      handleBlocked: vi.fn().mockResolvedValueOnce({
        action: "instruct",
        instruction: "try X instead",
      }),
    });
    let callCount = 0;
    const stages = [
      makeStage(1, async (ctx) => {
        callCount++;
        if (callCount === 1) {
          return { outcome: "blocked", message: "stuck" };
        }
        receivedInstruction = ctx.userInstruction;
        return { outcome: "completed", message: "done" };
      }),
    ];
    await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(receivedInstruction).toBe("try X instead");
  });
});

// ---------------------------------------------------------------------------
// runPipeline — error handling
// ---------------------------------------------------------------------------
describe("runPipeline — error handling", () => {
  test("aborts on error when user chooses abort", async () => {
    const prompt = makePrompt({
      handleError: vi.fn().mockResolvedValue({ action: "abort" }),
    });
    const stages = [
      makeStage(1, async () => ({
        outcome: "error",
        message: "crash",
      })),
    ];
    const result = await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(result.success).toBe(false);
  });

  test("skips stage on error when user chooses skip", async () => {
    const prompt = makePrompt({
      handleError: vi.fn().mockResolvedValue({ action: "skip" }),
    });
    const stages = [
      makeStage(1, async () => ({
        outcome: "error",
        message: "crash",
      })),
      makeStage(2, async () => ({ outcome: "completed", message: "" })),
    ];
    const result = await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(result.success).toBe(true);
  });

  test("retries on error when user chooses retry", async () => {
    let callCount = 0;
    const prompt = makePrompt({
      handleError: vi.fn().mockResolvedValue({ action: "retry" }),
    });
    const stages = [
      makeStage(1, async () => {
        callCount++;
        if (callCount < 3) {
          return { outcome: "error", message: "crash" };
        }
        return { outcome: "completed", message: "done" };
      }),
    ];
    const result = await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(result.success).toBe(true);
    expect(callCount).toBe(3);
  });

  test("handles thrown exceptions like error outcomes", async () => {
    const prompt = makePrompt({
      handleError: vi.fn().mockResolvedValue({ action: "abort" }),
    });
    const stages = [
      makeStage(1, async () => {
        throw new Error("unexpected crash");
      }),
    ];
    const result = await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(result.success).toBe(false);
    expect(prompt.handleError).toHaveBeenCalledWith("unexpected crash");
  });
});

// ---------------------------------------------------------------------------
// runPipeline — ambiguous / needs_clarification handling
// ---------------------------------------------------------------------------
describe("runPipeline — needs_clarification handling", () => {
  test("halts on ambiguous when user chooses halt", async () => {
    const prompt = makePrompt({
      handleAmbiguous: vi.fn().mockResolvedValue({ action: "halt" }),
    });
    const stages = [
      makeStage(1, async () => ({
        outcome: "needs_clarification",
        message: "unclear",
      })),
    ];
    const result = await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(result.success).toBe(false);
  });

  test("proceeds on ambiguous when user chooses proceed", async () => {
    const prompt = makePrompt({
      handleAmbiguous: vi.fn().mockResolvedValue({ action: "proceed" }),
    });
    const stages = [
      makeStage(1, async () => ({
        outcome: "needs_clarification",
        message: "unclear",
      })),
      makeStage(2, async () => ({ outcome: "completed", message: "" })),
    ];
    const result = await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(result.success).toBe(true);
  });

  test("continues with instruction on ambiguous after auto-clarification", async () => {
    let receivedInstruction: string | undefined;
    const prompt = makePrompt({
      handleAmbiguous: vi.fn().mockResolvedValue({
        action: "instruct",
        instruction: "be clearer",
      }),
    });
    let callCount = 0;
    const stages = [
      makeStage(1, async (ctx) => {
        callCount++;
        if (callCount <= 2) {
          // Call 1: ambiguous → engine auto-retries with clarification prompt.
          // Call 2: still ambiguous → engine falls back to user.
          return { outcome: "needs_clarification", message: "unclear" };
        }
        // Call 3: user instruction arrives.
        receivedInstruction = ctx.userInstruction;
        return { outcome: "completed", message: "done" };
      }),
    ];
    await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(callCount).toBe(3);
    expect(receivedInstruction).toBe("be clearer");
  });

  test("auto-clarification sends buildClarificationPrompt on first ambiguous", async () => {
    let receivedInstruction: string | undefined;
    const stages = [
      makeStage(1, async (ctx) => {
        if (ctx.iteration === 0) {
          return { outcome: "needs_clarification", message: "vague" };
        }
        // Iteration 1 receives auto-clarification prompt.
        receivedInstruction = ctx.userInstruction;
        return { outcome: "completed", message: "done" };
      }),
    ];
    await runPipeline(makePipelineOpts({ stages }));
    expect(receivedInstruction).toBe(buildClarificationPrompt("vague"));
  });

  test("handleAmbiguous not called on first ambiguous (auto-retry first)", async () => {
    const prompt = makePrompt();
    let callCount = 0;
    const stages = [
      makeStage(1, async () => {
        callCount++;
        if (callCount === 1) {
          return { outcome: "needs_clarification", message: "vague" };
        }
        // Second call succeeds.
        return { outcome: "completed", message: "done" };
      }),
    ];
    await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(prompt.handleAmbiguous).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runPipeline — edge cases
// ---------------------------------------------------------------------------
describe("runPipeline — edge cases", () => {
  test("handles non-Error thrown exceptions", async () => {
    const prompt = makePrompt({
      handleError: vi.fn().mockResolvedValue({ action: "abort" }),
    });
    const stages = [
      makeStage(1, async () => {
        throw "string error"; // eslint-disable-line no-throw-literal
      }),
    ];
    const result = await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(result.success).toBe(false);
    expect(prompt.handleError).toHaveBeenCalledWith("string error");
  });

  test("user instruction is cleared after one use", async () => {
    const instructions: (string | undefined)[] = [];
    const prompt = makePrompt({
      handleBlocked: vi.fn().mockResolvedValueOnce({
        action: "instruct",
        instruction: "do X",
      }),
    });
    let callCount = 0;
    const stages = [
      makeStage(1, async (ctx) => {
        callCount++;
        instructions.push(ctx.userInstruction);
        if (callCount === 1) {
          return { outcome: "blocked", message: "stuck" };
        }
        if (callCount === 2) {
          return { outcome: "not_approved", message: "nope" };
        }
        return { outcome: "completed", message: "done" };
      }),
    ];
    await runPipeline(makePipelineOpts({ stages, prompt }));
    // Call 1: no instruction, call 2: "do X" (from instruct),
    // call 3: "nope" (from not_approved — message is forwarded as feedback).
    expect(instructions).toEqual([undefined, "do X", "nope"]);
  });

  test("empty message in blocked outcome is forwarded", async () => {
    const prompt = makePrompt({
      handleBlocked: vi.fn().mockResolvedValue({ action: "halt" }),
    });
    const stages = [
      makeStage(1, async () => ({ outcome: "blocked", message: "" })),
    ];
    await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(prompt.handleBlocked).toHaveBeenCalledWith("", true);
  });

  test("step mode loops within a stage run as auto", async () => {
    let calls = 0;
    const prompt = makePrompt({
      confirmContinueLoop: vi.fn().mockResolvedValue(false),
    });
    const stages = [
      makeStage(1, async () => {
        calls++;
        return { outcome: "not_approved", message: "again" };
      }),
    ];
    await runPipeline(makePipelineOpts({ mode: "step", stages, prompt }));
    // 3 auto iterations within the stage, then user asked about loop.
    expect(calls).toBe(3);
    expect(prompt.confirmNextStage).toHaveBeenCalledTimes(1);
    expect(prompt.confirmContinueLoop).toHaveBeenCalledTimes(1);
  });

  test("multiple user approvals grant 3 iterations each", async () => {
    let calls = 0;
    const prompt = makePrompt({
      confirmContinueLoop: vi
        .fn()
        .mockResolvedValueOnce(true) // 4th–6th
        .mockResolvedValueOnce(true) // 7th–9th
        .mockResolvedValue(false), // 10th declined
    });
    const stages = [
      makeStage(1, async () => {
        calls++;
        return { outcome: "not_approved", message: "more" };
      }),
    ];
    await runPipeline(makePipelineOpts({ stages, prompt }));
    // 3 + 3 + 3 = 9 iterations.
    expect(calls).toBe(9);
    expect(prompt.confirmContinueLoop).toHaveBeenCalledTimes(3);
  });

  test("error retry does not consume loop budget", async () => {
    let calls = 0;
    const prompt = makePrompt({
      handleError: vi
        .fn()
        .mockResolvedValueOnce({ action: "retry" })
        .mockResolvedValue({ action: "abort" }),
    });
    const stages = [
      makeStage(1, async () => {
        calls++;
        if (calls === 1) {
          return { outcome: "error", message: "transient" };
        }
        // After retry, still an error to test budget.
        return { outcome: "error", message: "persistent" };
      }),
    ];
    await runPipeline(makePipelineOpts({ stages, prompt }));
    // Retry doesn't advance loop, so no loop-budget prompt.
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// createDoneStageHandler
// ---------------------------------------------------------------------------
function makeDoneOpts(
  overrides: Partial<Parameters<typeof createDoneStageHandler>[0]> = {},
) {
  return {
    reportCompletion: vi.fn().mockResolvedValue(undefined),
    confirmMerge: vi.fn().mockResolvedValue(true),
    cleanup: vi.fn(),
    ...overrides,
  };
}

describe("createDoneStageHandler", () => {
  test("returns stage definition with number 9", () => {
    const stage = createDoneStageHandler(makeDoneOpts());
    expect(stage.number).toBe(9);
    expect(stage.name).toBe("Done");
  });

  test("reports completion, confirms merge, then cleans up", async () => {
    const opts = makeDoneOpts();
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    expect(opts.reportCompletion).toHaveBeenCalledOnce();
    expect(opts.confirmMerge).toHaveBeenCalledOnce();
    expect(opts.cleanup).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("org/repo#5");
    expect(result.message).toContain("cleaned up");
  });

  test("preserves worktree when merge not confirmed", async () => {
    const opts = makeDoneOpts({
      confirmMerge: vi.fn().mockResolvedValue(false),
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    expect(opts.reportCompletion).toHaveBeenCalledOnce();
    expect(opts.confirmMerge).toHaveBeenCalledOnce();
    expect(opts.cleanup).not.toHaveBeenCalled();
    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("preserved");
  });
});

// ---------------------------------------------------------------------------
// E2E: multi-stage pipeline with mixed outcomes
// ---------------------------------------------------------------------------
describe("E2E — multi-stage pipeline", () => {
  test("3 stages: complete → blocked+instruct → complete", async () => {
    const prompt = makePrompt({
      handleBlocked: vi.fn().mockResolvedValue({
        action: "instruct",
        instruction: "fix the test",
      }),
    });
    let stage2calls = 0;
    const stages = [
      makeStage(1, async () => ({ outcome: "completed", message: "s1" })),
      makeStage(2, async () => {
        stage2calls++;
        if (stage2calls === 1) {
          return { outcome: "blocked", message: "need help" };
        }
        return { outcome: "fixed", message: "s2" };
      }),
      makeStage(3, async () => ({ outcome: "approved", message: "s3" })),
    ];
    const result = await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(result.success).toBe(true);
    expect(stage2calls).toBe(2);
  });

  test("step mode: approve all stages with loop in middle stage", async () => {
    const prompt = makePrompt({
      confirmNextStage: vi.fn().mockResolvedValue(true),
      confirmContinueLoop: vi.fn().mockResolvedValue(false),
    });
    let s2calls = 0;
    const stages = [
      makeStage(1, async () => ({ outcome: "completed", message: "" })),
      makeStage(2, async () => {
        s2calls++;
        if (s2calls <= 3) {
          return { outcome: "not_approved", message: "retry" };
        }
        return { outcome: "completed", message: "" };
      }),
      makeStage(3, async () => ({ outcome: "completed", message: "" })),
    ];
    const result = await runPipeline(
      makePipelineOpts({ mode: "step", stages, prompt }),
    );
    // Stage 2 loops 3 times, then user declines loop → pipeline aborts.
    expect(result.success).toBe(false);
    expect(result.stoppedAt).toBe(2);
    expect(prompt.confirmNextStage).toHaveBeenCalledTimes(2);
  });

  test("error in stage 1 skip → stage 2 completes → success", async () => {
    const prompt = makePrompt({
      handleError: vi.fn().mockResolvedValue({ action: "skip" }),
    });
    const stages = [
      makeStage(1, async () => ({ outcome: "error", message: "boom" })),
      makeStage(2, async () => ({ outcome: "completed", message: "" })),
    ];
    const result = await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(result.success).toBe(true);
  });

  test("thrown exception in stage 2, retry succeeds", async () => {
    let s2calls = 0;
    const prompt = makePrompt({
      handleError: vi.fn().mockResolvedValue({ action: "retry" }),
    });
    const stages = [
      makeStage(1, async () => ({ outcome: "completed", message: "" })),
      makeStage(2, async () => {
        s2calls++;
        if (s2calls === 1) {
          throw new Error("transient failure");
        }
        return { outcome: "completed", message: "" };
      }),
    ];
    const result = await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(result.success).toBe(true);
    expect(s2calls).toBe(2);
  });

  test("clarification flow across stages does not leak state", async () => {
    // Stage 1 triggers ambiguous → auto-clarification → succeeds.
    // Stage 2 triggers ambiguous → auto-clarification should fire again
    // (not carry over the "already attempted" flag from stage 1).
    let s1calls = 0;
    let s2calls = 0;
    const stages = [
      makeStage(1, async () => {
        s1calls++;
        if (s1calls === 1) {
          return { outcome: "needs_clarification", message: "vague1" };
        }
        return { outcome: "completed", message: "" };
      }),
      makeStage(2, async () => {
        s2calls++;
        if (s2calls === 1) {
          return { outcome: "needs_clarification", message: "vague2" };
        }
        return { outcome: "completed", message: "" };
      }),
    ];
    const prompt = makePrompt();
    const result = await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(result.success).toBe(true);
    // Each stage should get auto-clarification → succeed on 2nd call.
    expect(s1calls).toBe(2);
    expect(s2calls).toBe(2);
    // handleAmbiguous should NOT have been called (auto-clarification succeeded).
    expect(prompt.handleAmbiguous).not.toHaveBeenCalled();
  });

  test("full pipeline with Done stage (stage 9) runs cleanup", async () => {
    const opts = makeDoneOpts();
    const stages = [
      makeStage(1, async () => ({ outcome: "completed", message: "" })),
      createDoneStageHandler(opts),
    ];
    const result = await runPipeline(makePipelineOpts({ stages }));
    expect(result.success).toBe(true);
    expect(opts.reportCompletion).toHaveBeenCalledOnce();
    expect(opts.confirmMerge).toHaveBeenCalledOnce();
    expect(opts.cleanup).toHaveBeenCalledOnce();
  });
});
