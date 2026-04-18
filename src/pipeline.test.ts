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
import {
  PipelineEventEmitter,
  type StageEnterEvent,
  type StageExitEvent,
  type StageNameOverrideEvent,
} from "./pipeline-events.js";
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
    confirmMerge: vi.fn().mockResolvedValue("merged"),
    handleConflict: vi.fn().mockResolvedValue("manual"),
    handleUnknownMergeable: vi.fn().mockResolvedValue("exit"),
    waitForManualResolve: vi.fn().mockResolvedValue(undefined),
    confirmCleanup: vi.fn().mockResolvedValue(false),
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

const BASE_CTX: Omit<
  StageContext,
  "iteration" | "lastAutoIteration" | "userInstruction"
> = {
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

  test("forwards not_approved message to confirmContinueLoop", async () => {
    const prompt = makePrompt({
      confirmContinueLoop: vi.fn().mockResolvedValue(false),
    });
    const stages = [
      makeStage(1, async () => ({
        outcome: "not_approved",
        message: "round feedback",
      })),
    ];
    await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(prompt.confirmContinueLoop).toHaveBeenCalledWith(
      "Stage 1",
      3,
      "round feedback",
    );
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

  test("sets lastAutoIteration on the final auto-iteration", async () => {
    const flags: boolean[] = [];
    const prompt = makePrompt({
      confirmContinueLoop: vi.fn().mockResolvedValue(false),
    });
    const stages = [
      makeStage(1, async (ctx) => {
        flags.push(ctx.lastAutoIteration);
        return { outcome: "not_approved", message: "again" };
      }),
    ];
    await runPipeline(makePipelineOpts({ stages, prompt }));
    // Budget 3: iterations 0,1 → false; iteration 2 → true (last auto).
    expect(flags).toEqual([false, false, true]);
  });

  test("lastAutoIteration resets to false after user grants new budget", async () => {
    const flags: boolean[] = [];
    const prompt = makePrompt({
      confirmContinueLoop: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValue(false),
    });
    const stages = [
      makeStage(1, async (ctx) => {
        flags.push(ctx.lastAutoIteration);
        return { outcome: "not_approved", message: "again" };
      }),
    ];
    await runPipeline(makePipelineOpts({ stages, prompt }));
    // Budget 3: [false, false, true] → user grants → [false, false, true]
    expect(flags).toEqual([false, false, true, false, false, true]);
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

  test("auto-clarification uses validVerdicts to scope the prompt", async () => {
    let receivedInstruction: string | undefined;
    const scopedKeywords = ["APPROVED", "NOT_APPROVED"] as const;
    const stages = [
      makeStage(1, async (ctx) => {
        if (ctx.iteration === 0) {
          return {
            outcome: "needs_clarification",
            message: "vague",
            validVerdicts: scopedKeywords,
          } satisfies StageResult;
        }
        receivedInstruction = ctx.userInstruction;
        return { outcome: "completed", message: "done" };
      }),
    ];
    await runPipeline(makePipelineOpts({ stages }));
    const expected = buildClarificationPrompt("vague", scopedKeywords);
    expect(receivedInstruction).toBe(expected);
    // The scoped prompt must mention the valid keywords.
    expect(receivedInstruction).toContain("APPROVED");
    expect(receivedInstruction).toContain("NOT_APPROVED");
    // It must NOT mention keywords outside the scoped set.
    expect(receivedInstruction).not.toContain("COMPLETED");
    expect(receivedInstruction).not.toContain("BLOCKED");
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
// runPipeline — backward stage transition (restartFromStage)
// ---------------------------------------------------------------------------
describe("runPipeline — backward stage transition", () => {
  test("restartFromStage causes pipeline to jump back to earlier stage", async () => {
    const order: number[] = [];
    let s2calls = 0;
    const stages = [
      makeStage(1, async () => {
        order.push(1);
        return { outcome: "completed", message: "" };
      }),
      makeStage(
        2,
        async () => {
          order.push(2);
          s2calls++;
          if (s2calls === 1) {
            return { outcome: "not_approved", message: "need restart" };
          }
          return { outcome: "completed", message: "" };
        },
        { restartFromStage: 1 },
      ),
    ];
    const result = await runPipeline(makePipelineOpts({ stages }));
    expect(result.success).toBe(true);
    // Stage 1 → Stage 2 (not_approved → restart from 1) → Stage 1 → Stage 2 (completed)
    expect(order).toEqual([1, 2, 1, 2]);
  });

  test("restart budget: 3 auto restarts then asks user", async () => {
    let s2calls = 0;
    const prompt = makePrompt({
      confirmContinueLoop: vi.fn().mockResolvedValue(false),
    });
    const stages = [
      makeStage(1, async () => ({ outcome: "completed", message: "" })),
      makeStage(
        2,
        async () => {
          s2calls++;
          return { outcome: "not_approved", message: "restart" };
        },
        { restartFromStage: 1 },
      ),
    ];
    const result = await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(result.success).toBe(false);
    expect(result.stoppedAt).toBe(2);
    // 3 auto restarts, then user asked and declines
    expect(prompt.confirmContinueLoop).toHaveBeenCalledTimes(1);
    // Stage 1 runs 3 times (once initial + re-entered on each restart),
    // Stage 2 runs 3 times (initial + 2 re-entries before budget check)
    // Actually: initial run = stage1 + stage2(restart). Then stage1 + stage2(restart).
    // Then stage1 + stage2(restart, budget=0, ask user, decline).
    // So s2calls = 3.
    expect(s2calls).toBe(3);
  });

  test("restart budget: user approves then 3 more auto restarts", async () => {
    let s2calls = 0;
    const prompt = makePrompt({
      confirmContinueLoop: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValue(false),
    });
    const stages = [
      makeStage(1, async () => ({ outcome: "completed", message: "" })),
      makeStage(
        2,
        async () => {
          s2calls++;
          return { outcome: "not_approved", message: "restart" };
        },
        { restartFromStage: 1 },
      ),
    ];
    const result = await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(result.success).toBe(false);
    // 3 auto + user approves + 3 more + user declines = 6
    expect(s2calls).toBe(6);
    expect(prompt.confirmContinueLoop).toHaveBeenCalledTimes(2);
  });

  test("restart budget uses stage autoBudget override", async () => {
    let s2calls = 0;
    const prompt = makePrompt({
      confirmContinueLoop: vi.fn().mockResolvedValue(false),
    });
    const stages = [
      makeStage(1, async () => ({ outcome: "completed", message: "" })),
      makeStage(
        2,
        async () => {
          s2calls++;
          return { outcome: "not_approved", message: "restart" };
        },
        { restartFromStage: 1, autoBudget: 2 },
      ),
    ];
    await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(s2calls).toBe(2);
  });

  test("restart budget clears when stage completes normally", async () => {
    // Run pipeline twice (two stages that restart).
    // Second restart stage should get a fresh budget.
    let s2calls = 0;
    let s3calls = 0;
    const stages = [
      makeStage(1, async () => ({ outcome: "completed", message: "" })),
      makeStage(
        2,
        async () => {
          s2calls++;
          if (s2calls <= 2) {
            return { outcome: "not_approved", message: "restart" };
          }
          return { outcome: "completed", message: "" };
        },
        { restartFromStage: 1 },
      ),
      makeStage(
        3,
        async () => {
          s3calls++;
          if (s3calls === 1) {
            return { outcome: "not_approved", message: "restart" };
          }
          return { outcome: "completed", message: "" };
        },
        { restartFromStage: 2 },
      ),
    ];
    const result = await runPipeline(makePipelineOpts({ stages }));
    expect(result.success).toBe(true);
    expect(s2calls).toBe(4); // 3 from own restarts + 1 from stage 3's restart
    expect(s3calls).toBe(2);
  });

  test("invalid restart target (forward jump) throws at startup", async () => {
    const stages = [
      makeStage(1, async () => ({ outcome: "completed", message: "" })),
      makeStage(
        2,
        async () => ({ outcome: "not_approved", message: "bad" }),
        { restartFromStage: 3 }, // forward jump — invalid
      ),
      makeStage(3, async () => ({ outcome: "completed", message: "" })),
    ];
    await expect(runPipeline(makePipelineOpts({ stages }))).rejects.toThrow(
      "not an earlier stage",
    );
  });

  test("invalid restart target (nonexistent stage) throws at startup", async () => {
    const stages = [
      makeStage(1, async () => ({ outcome: "completed", message: "" })),
      makeStage(2, async () => ({ outcome: "not_approved", message: "bad" }), {
        restartFromStage: 99,
      }),
    ];
    await expect(runPipeline(makePipelineOpts({ stages }))).rejects.toThrow(
      "does not exist",
    );
  });

  test("self-jump (restartFromStage = own number) throws at startup", async () => {
    const stages = [
      makeStage(1, async () => ({ outcome: "not_approved", message: "loop" }), {
        restartFromStage: 1,
      }),
    ];
    await expect(runPipeline(makePipelineOpts({ stages }))).rejects.toThrow(
      "not an earlier stage",
    );
  });

  test("blocked in stage with restartFromStage does NOT restart", async () => {
    let s1calls = 0;
    const prompt = makePrompt({
      handleBlocked: vi.fn().mockResolvedValue({ action: "halt" }),
    });
    const stages = [
      makeStage(1, async () => {
        s1calls++;
        return { outcome: "completed", message: "" };
      }),
      makeStage(2, async () => ({ outcome: "blocked", message: "stuck" }), {
        restartFromStage: 1,
      }),
    ];
    const result = await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(result.success).toBe(false);
    expect(s1calls).toBe(1); // stage 1 NOT re-entered
    expect(prompt.handleBlocked).toHaveBeenCalledOnce();
  });

  test("error in stage with restartFromStage does NOT restart", async () => {
    let s1calls = 0;
    const prompt = makePrompt({
      handleError: vi.fn().mockResolvedValue({ action: "abort" }),
    });
    const stages = [
      makeStage(1, async () => {
        s1calls++;
        return { outcome: "completed", message: "" };
      }),
      makeStage(2, async () => ({ outcome: "error", message: "crash" }), {
        restartFromStage: 1,
      }),
    ];
    const result = await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(result.success).toBe(false);
    expect(s1calls).toBe(1);
    expect(prompt.handleError).toHaveBeenCalledOnce();
  });

  test("needs_clarification in stage with restartFromStage does NOT restart", async () => {
    let s1calls = 0;
    const prompt = makePrompt({
      handleAmbiguous: vi.fn().mockResolvedValue({ action: "halt" }),
    });
    const stages = [
      makeStage(1, async () => {
        s1calls++;
        return { outcome: "completed", message: "" };
      }),
      makeStage(
        2,
        async () => ({ outcome: "needs_clarification", message: "unclear" }),
        { restartFromStage: 1 },
      ),
    ];
    const result = await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(result.success).toBe(false);
    expect(s1calls).toBe(1);
  });

  test("step mode asks confirmNextStage on every entry including restart re-entry", async () => {
    let s2calls = 0;
    const prompt = makePrompt();
    const stages = [
      makeStage(1, async () => ({ outcome: "completed", message: "" })),
      makeStage(
        2,
        async () => {
          s2calls++;
          if (s2calls === 1) {
            return { outcome: "not_approved", message: "restart" };
          }
          return { outcome: "completed", message: "" };
        },
        { restartFromStage: 1 },
      ),
    ];
    await runPipeline(makePipelineOpts({ mode: "step", stages, prompt }));
    // Initial: confirm stage 1, confirm stage 2.
    // After restart: confirm stage 1 again, confirm stage 2 again.
    expect(prompt.confirmNextStage).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// createDoneStageHandler
// ---------------------------------------------------------------------------
function makeDonePrompt(
  overrides: Partial<
    Parameters<typeof createDoneStageHandler>[0]["prompt"]
  > = {},
) {
  return {
    confirmMerge: vi.fn().mockResolvedValue("merged"),
    handleConflict: vi.fn().mockResolvedValue("manual"),
    handleUnknownMergeable: vi.fn().mockResolvedValue("exit"),
    waitForManualResolve: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeDoneOpts(
  overrides: Partial<Parameters<typeof createDoneStageHandler>[0]> = {},
) {
  const { prompt: promptOverrides, ...rest } = overrides;
  return {
    checkMergeable: vi.fn().mockResolvedValue("MERGEABLE"),
    prompt: makeDonePrompt(promptOverrides),
    rebaseOntoMain: vi.fn().mockResolvedValue({ success: true, message: "ok" }),
    pollCiAndFix: vi
      .fn()
      .mockResolvedValue({ passed: true, message: "CI passed" }),
    cleanup: vi.fn(),
    stopServices: vi.fn(),
    hasRunningServices: vi.fn().mockReturnValue(false),
    onNotMerged: vi.fn().mockResolvedValue(undefined),
    ...rest,
  };
}

describe("createDoneStageHandler", () => {
  test("returns stage definition with number 9", () => {
    const stage = createDoneStageHandler(makeDoneOpts());
    expect(stage.number).toBe(9);
    expect(stage.name).toBe("Done");
  });

  test("MERGEABLE: includes squash suggestion hint in confirmMerge message", async () => {
    const confirmMerge = vi.fn().mockResolvedValue("merged");
    const opts = makeDoneOpts({
      prompt: { confirmMerge },
      getSquashMergeHint: () => ({
        title: "Fix widget rendering",
        body: "Body line\n\nCloses #5",
        prUrl: "https://github.com/org/repo/pull/123",
      }),
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    await stage.handler(ctx);
    expect(confirmMerge).toHaveBeenCalledOnce();
    const message = confirmMerge.mock.calls[0][0] as string;
    expect(message).toContain("Squash and merge");
    expect(message).toContain("Fix widget rendering");
    expect(message).toContain("Closes #5");
    expect(message).toContain("https://github.com/org/repo/pull/123");
  });

  test("MERGEABLE: omits hint when getSquashMergeHint returns undefined", async () => {
    const confirmMerge = vi.fn().mockResolvedValue("merged");
    const opts = makeDoneOpts({
      prompt: { confirmMerge },
      getSquashMergeHint: () => undefined,
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    await stage.handler(ctx);
    const message = confirmMerge.mock.calls[0][0] as string;
    expect(message).not.toContain("Squash and merge");
  });

  test("MERGEABLE: confirms merge, stops services, then cleans up", async () => {
    const opts = makeDoneOpts();
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    expect(opts.checkMergeable).toHaveBeenCalledOnce();
    expect(opts.prompt.confirmMerge).toHaveBeenCalledOnce();
    expect(opts.stopServices).toHaveBeenCalledOnce();
    expect(opts.cleanup).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("org/repo#5");
    expect(result.message).toContain("cleaned up");
  });

  test("MERGEABLE: calls onNotMerged when user exits", async () => {
    const opts = makeDoneOpts({
      prompt: { confirmMerge: vi.fn().mockResolvedValue("exit") },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    expect(opts.prompt.confirmMerge).toHaveBeenCalledOnce();
    expect(opts.cleanup).not.toHaveBeenCalled();
    expect(opts.onNotMerged).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("org/repo#5");
  });

  test("UNKNOWN: exits to cleanup when user chooses exit", async () => {
    const opts = makeDoneOpts({
      checkMergeable: vi.fn().mockResolvedValue("UNKNOWN"),
      prompt: { handleUnknownMergeable: vi.fn().mockResolvedValue("exit") },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    expect(opts.prompt.handleUnknownMergeable).toHaveBeenCalledOnce();
    expect(opts.onNotMerged).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("completed");
  });

  test("UNKNOWN: re-check then MERGEABLE proceeds to merge confirmation", async () => {
    const checkMergeable = vi
      .fn()
      .mockResolvedValueOnce("UNKNOWN")
      .mockResolvedValueOnce("MERGEABLE");
    const opts = makeDoneOpts({
      checkMergeable,
      prompt: { handleUnknownMergeable: vi.fn().mockResolvedValue("recheck") },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    expect(checkMergeable).toHaveBeenCalledTimes(2);
    expect(opts.prompt.confirmMerge).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("cleaned up");
  });

  test("CONFLICTING: agent rebase succeeds, CI passes, then merge confirmation", async () => {
    const checkMergeable = vi
      .fn()
      .mockResolvedValueOnce("CONFLICTING")
      .mockResolvedValueOnce("MERGEABLE");
    const opts = makeDoneOpts({
      checkMergeable,
      prompt: { handleConflict: vi.fn().mockResolvedValue("agent_rebase") },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    expect(opts.rebaseOntoMain).toHaveBeenCalledOnce();
    expect(opts.pollCiAndFix).toHaveBeenCalledOnce();
    expect(opts.prompt.confirmMerge).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("cleaned up");
  });

  test("CONFLICTING: manual resolve, CI passes, then merge confirmation", async () => {
    const checkMergeable = vi
      .fn()
      .mockResolvedValueOnce("CONFLICTING")
      .mockResolvedValueOnce("MERGEABLE");
    const opts = makeDoneOpts({
      checkMergeable,
      prompt: { handleConflict: vi.fn().mockResolvedValue("manual") },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    expect(opts.rebaseOntoMain).not.toHaveBeenCalled();
    expect(opts.prompt.waitForManualResolve).toHaveBeenCalledOnce();
    expect(opts.pollCiAndFix).toHaveBeenCalledOnce();
    expect(opts.prompt.confirmMerge).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("completed");
  });

  test("CONFLICTING: agent rebase fails, falls back to manual", async () => {
    const checkMergeable = vi
      .fn()
      .mockResolvedValueOnce("CONFLICTING")
      .mockResolvedValueOnce("MERGEABLE");
    const opts = makeDoneOpts({
      checkMergeable,
      rebaseOntoMain: vi
        .fn()
        .mockResolvedValue({ success: false, message: "conflict" }),
      prompt: {
        handleConflict: vi.fn().mockResolvedValue("agent_rebase"),
      },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    expect(opts.rebaseOntoMain).toHaveBeenCalledOnce();
    // After agent failure, user sees rebaseFailed notification (via
    // waitForManualResolve), not a second handleConflict prompt.
    expect(opts.prompt.handleConflict).toHaveBeenCalledOnce();
    expect(opts.prompt.waitForManualResolve).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("completed");
  });

  test("CONFLICTING: CI failure after resolution calls onNotMerged", async () => {
    const checkMergeable = vi
      .fn()
      .mockResolvedValueOnce("CONFLICTING")
      .mockResolvedValueOnce("MERGEABLE");
    const opts = makeDoneOpts({
      checkMergeable,
      pollCiAndFix: vi
        .fn()
        .mockResolvedValue({ passed: false, message: "CI fix exhausted" }),
      prompt: { handleConflict: vi.fn().mockResolvedValue("manual") },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    expect(opts.pollCiAndFix).toHaveBeenCalledOnce();
    expect(opts.onNotMerged).toHaveBeenCalledOnce();
    expect(opts.prompt.confirmMerge).not.toHaveBeenCalled();
    expect(result.outcome).toBe("completed");
    expect(result.message).toBe("CI fix exhausted");
  });

  test("CONFLICTING: still conflicting after manual resolve loops back", async () => {
    // Flow: mergeableLoop → CONFLICTING → handleConflicting → manual →
    // waitForManualResolve → afterResolution → CONFLICTING → undefined →
    // loop back → mergeableLoop → CONFLICTING → handleConflicting →
    // manual → waitForManualResolve → afterResolution → MERGEABLE →
    // pollCiAndFix → askMerge.
    const checkMergeable = vi
      .fn()
      .mockResolvedValueOnce("CONFLICTING")
      .mockResolvedValueOnce("CONFLICTING")
      .mockResolvedValueOnce("CONFLICTING")
      .mockResolvedValueOnce("MERGEABLE");
    const handleConflict = vi.fn().mockResolvedValue("manual");
    const opts = makeDoneOpts({
      checkMergeable,
      prompt: { handleConflict },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    expect(checkMergeable).toHaveBeenCalledTimes(4);
    expect(handleConflict).toHaveBeenCalledTimes(2);
    expect(opts.prompt.waitForManualResolve).toHaveBeenCalledTimes(2);
    expect(opts.prompt.confirmMerge).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("completed");
  });

  test("agent rebase limited to 1 attempt across loop-backs", async () => {
    // Flow: mergeableLoop → CONFLICTING → handleConflicting → agent_rebase
    // → rebaseOntoMain (rebaseAttempted=true) → afterResolution →
    // CONFLICTING → undefined → loop back → mergeableLoop → CONFLICTING →
    // handleConflicting (rebaseAttempted=true, skips to manual) →
    // waitForManualResolve → afterResolution → MERGEABLE → pollCiAndFix →
    // askMerge.
    const checkMergeable = vi
      .fn()
      .mockResolvedValueOnce("CONFLICTING")
      .mockResolvedValueOnce("CONFLICTING")
      .mockResolvedValueOnce("CONFLICTING")
      .mockResolvedValueOnce("MERGEABLE");
    const handleConflict = vi.fn().mockResolvedValue("agent_rebase");
    const rebaseOntoMain = vi
      .fn()
      .mockResolvedValue({ success: true, message: "ok" });
    const opts = makeDoneOpts({
      checkMergeable,
      rebaseOntoMain,
      prompt: { handleConflict },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    // Rebase called only once despite two CONFLICTING states.
    expect(rebaseOntoMain).toHaveBeenCalledOnce();
    // handleConflict shown only for the first CONFLICTING — the loop-back
    // skips straight to waitForManualResolve because rebase was attempted.
    expect(handleConflict).toHaveBeenCalledOnce();
    // waitForManualResolve called for the loop-back (rebase already used).
    expect(opts.prompt.waitForManualResolve).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("completed");
  });

  test("abort during checkMergeable skips everything", async () => {
    const controller = new AbortController();
    const opts = makeDoneOpts({
      checkMergeable: vi.fn().mockImplementation(async () => {
        controller.abort();
        return "MERGEABLE";
      }),
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
      signal: controller.signal,
    };
    await stage.handler(ctx);
    expect(opts.prompt.confirmMerge).not.toHaveBeenCalled();
    expect(opts.cleanup).not.toHaveBeenCalled();
  });

  test("abort during confirmMerge skips cleanup and onNotMerged", async () => {
    const controller = new AbortController();
    const opts = makeDoneOpts({
      prompt: {
        confirmMerge: vi.fn().mockImplementation(async () => {
          controller.abort();
          return "exit";
        }),
      },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
      signal: controller.signal,
    };
    await stage.handler(ctx);
    expect(opts.prompt.confirmMerge).toHaveBeenCalledOnce();
    expect(opts.cleanup).not.toHaveBeenCalled();
    expect(opts.stopServices).not.toHaveBeenCalled();
    expect(opts.onNotMerged).not.toHaveBeenCalled();
  });

  test("full pipeline abort during stage 9 checkMergeable returns cancelled", async () => {
    const controller = new AbortController();
    const opts = makeDoneOpts({
      checkMergeable: vi.fn().mockImplementation(async () => {
        controller.abort();
        return "MERGEABLE";
      }),
    });
    const stage = createDoneStageHandler(opts);
    const result = await runPipeline(
      makePipelineOpts({
        stages: [stage],
        signal: controller.signal,
      }),
    );
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(opts.prompt.confirmMerge).not.toHaveBeenCalled();
  });

  test("full pipeline abort during stage 9 confirmMerge returns cancelled", async () => {
    const controller = new AbortController();
    const opts = makeDoneOpts({
      prompt: {
        confirmMerge: vi.fn().mockImplementation(async () => {
          controller.abort();
          return "merged";
        }),
      },
    });
    const stage = createDoneStageHandler(opts);
    const result = await runPipeline(
      makePipelineOpts({
        stages: [stage],
        signal: controller.signal,
      }),
    );
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(opts.cleanup).not.toHaveBeenCalled();
  });

  test("CONFLICTING: agent rebase returning success: false does not advance to CI", async () => {
    // When rebaseOntoMain returns success: false (e.g. agent could not
    // resolve conflicts), the handler should fall back to manual resolve
    // and NOT proceed directly to pollCiAndFix.
    const checkMergeable = vi
      .fn()
      .mockResolvedValueOnce("CONFLICTING")
      .mockResolvedValueOnce("MERGEABLE");
    const rebaseOntoMain = vi.fn().mockResolvedValue({
      success: false,
      message: "I could not resolve the conflicts and aborted the rebase.",
    });
    const opts = makeDoneOpts({
      checkMergeable,
      rebaseOntoMain,
      prompt: {
        handleConflict: vi.fn().mockResolvedValue("agent_rebase"),
      },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    expect(rebaseOntoMain).toHaveBeenCalledOnce();
    // After agent failure, waitForManualResolve is shown (not pollCiAndFix).
    expect(opts.prompt.waitForManualResolve).toHaveBeenCalledOnce();
    // CI polling still happens after the manual resolve re-check.
    expect(opts.pollCiAndFix).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("completed");
  });

  // ---- stage:name-override events ------------------------------------------

  test("handleConflicting rebase emits Rebase then Done on success", async () => {
    const emitter = new PipelineEventEmitter();
    const names: string[] = [];
    emitter.on("stage:name-override", (ev: StageNameOverrideEvent) => {
      names.push(ev.stageName);
    });
    const checkMergeable = vi
      .fn()
      .mockResolvedValueOnce("CONFLICTING")
      .mockResolvedValueOnce("MERGEABLE");
    const opts = makeDoneOpts({
      events: emitter,
      checkMergeable,
      prompt: { handleConflict: vi.fn().mockResolvedValue("agent_rebase") },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    await stage.handler(ctx);
    // "Rebase" emitted before rebase, "Done" restored after CI poll.
    expect(names).toEqual(["Rebase", "Done"]);
  });

  test("handleConflicting rebase emits Rebase then Done on failure", async () => {
    const emitter = new PipelineEventEmitter();
    const names: string[] = [];
    emitter.on("stage:name-override", (ev: StageNameOverrideEvent) => {
      names.push(ev.stageName);
    });
    const checkMergeable = vi
      .fn()
      .mockResolvedValueOnce("CONFLICTING")
      .mockResolvedValueOnce("MERGEABLE");
    const opts = makeDoneOpts({
      events: emitter,
      checkMergeable,
      rebaseOntoMain: vi
        .fn()
        .mockResolvedValue({ success: false, message: "conflict" }),
      prompt: { handleConflict: vi.fn().mockResolvedValue("agent_rebase") },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    await stage.handler(ctx);
    // "Rebase" emitted before rebase, "Done" restored on failure.
    expect(names[0]).toBe("Rebase");
    expect(names[1]).toBe("Done");
  });

  test("askMerge inner rebase emits Rebase then Done", async () => {
    const emitter = new PipelineEventEmitter();
    const names: string[] = [];
    emitter.on("stage:name-override", (ev: StageNameOverrideEvent) => {
      names.push(ev.stageName);
    });
    const checkMergeable = vi
      .fn()
      .mockResolvedValueOnce("MERGEABLE") // initial → askMerge
      .mockResolvedValueOnce("CONFLICTING"); // inside askMerge
    const confirmMerge = vi
      .fn()
      .mockResolvedValueOnce("check_conflicts")
      .mockResolvedValueOnce("merged");
    const opts = makeDoneOpts({
      events: emitter,
      checkMergeable,
      prompt: { confirmMerge },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    await stage.handler(ctx);
    // "Rebase" emitted inside askMerge, "Done" restored after CI poll.
    expect(names).toEqual(["Rebase", "Done"]);
  });

  test("handleConflicting rebase emits Done on abort", async () => {
    const controller = new AbortController();
    const emitter = new PipelineEventEmitter();
    const names: string[] = [];
    emitter.on("stage:name-override", (ev: StageNameOverrideEvent) => {
      names.push(ev.stageName);
    });
    const opts = makeDoneOpts({
      events: emitter,
      checkMergeable: vi.fn().mockResolvedValue("CONFLICTING"),
      rebaseOntoMain: vi.fn().mockImplementation(async () => {
        controller.abort();
        return { success: true, message: "" };
      }),
      prompt: { handleConflict: vi.fn().mockResolvedValue("agent_rebase") },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
      signal: controller.signal,
    };
    await stage.handler(ctx);
    expect(names).toEqual(["Rebase", "Done"]);
  });

  test("askMerge inner rebase emits Done on abort", async () => {
    const controller = new AbortController();
    const emitter = new PipelineEventEmitter();
    const names: string[] = [];
    emitter.on("stage:name-override", (ev: StageNameOverrideEvent) => {
      names.push(ev.stageName);
    });
    const checkMergeable = vi
      .fn()
      .mockResolvedValueOnce("MERGEABLE")
      .mockResolvedValueOnce("CONFLICTING");
    const confirmMerge = vi.fn().mockResolvedValue("check_conflicts");
    const opts = makeDoneOpts({
      events: emitter,
      checkMergeable,
      rebaseOntoMain: vi.fn().mockImplementation(async () => {
        controller.abort();
        return { success: true, message: "" };
      }),
      prompt: { confirmMerge },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
      signal: controller.signal,
    };
    await stage.handler(ctx);
    expect(names).toEqual(["Rebase", "Done"]);
  });

  // ---- askMerge "check_conflicts" sub-path --------------------------------

  test("check_conflicts → MERGEABLE shows noConflicts message and loops back", async () => {
    // User selects "check_conflicts" first time (no conflicts),
    // then "merged" on the loop-back.
    const confirmMerge = vi
      .fn()
      .mockResolvedValueOnce("check_conflicts")
      .mockResolvedValueOnce("merged");
    const waitForManualResolve = vi.fn().mockResolvedValue(undefined);
    const opts = makeDoneOpts({
      prompt: { confirmMerge, waitForManualResolve },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    // checkMergeable: once at entry (MERGEABLE), once inside askMerge.
    expect(opts.checkMergeable).toHaveBeenCalledTimes(2);
    // "No conflicts" message shown via waitForManualResolve.
    expect(waitForManualResolve).toHaveBeenCalledWith(
      expect.stringContaining("No conflicts"),
    );
    expect(confirmMerge).toHaveBeenCalledTimes(2);
    expect(opts.cleanup).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("completed");
  });

  test("check_conflicts → CONFLICTING → rebase succeeds → CI → loops back", async () => {
    // Initial checkMergeable: MERGEABLE → askMerge.
    // User: "check_conflicts" → checkMergeable: CONFLICTING → rebase → CI → loop.
    // User: "merged" → cleanup.
    const checkMergeable = vi
      .fn()
      .mockResolvedValueOnce("MERGEABLE") // initial
      .mockResolvedValueOnce("CONFLICTING"); // inside askMerge
    const confirmMerge = vi
      .fn()
      .mockResolvedValueOnce("check_conflicts")
      .mockResolvedValueOnce("merged");
    const opts = makeDoneOpts({
      checkMergeable,
      prompt: { confirmMerge },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    expect(opts.rebaseOntoMain).toHaveBeenCalledOnce();
    expect(opts.pollCiAndFix).toHaveBeenCalledOnce();
    expect(confirmMerge).toHaveBeenCalledTimes(2);
    expect(opts.cleanup).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("completed");
  });

  test("check_conflicts → CONFLICTING → rebase succeeds → CI result shown before loop", async () => {
    // Regression: pollCiAndFix result must be surfaced via waitForManualResolve
    // before looping back to confirmMerge (for both pass and fail).
    const checkMergeable = vi
      .fn()
      .mockResolvedValueOnce("MERGEABLE") // initial
      .mockResolvedValueOnce("CONFLICTING"); // inside askMerge
    const confirmMerge = vi
      .fn()
      .mockResolvedValueOnce("check_conflicts")
      .mockResolvedValueOnce("merged");
    const waitForManualResolve = vi.fn().mockResolvedValue(undefined);
    const ciMessage = "CI failed: lint errors in src/foo.ts";
    const opts = makeDoneOpts({
      checkMergeable,
      pollCiAndFix: vi
        .fn()
        .mockResolvedValue({ passed: false, message: ciMessage }),
      prompt: { confirmMerge, waitForManualResolve },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    await stage.handler(ctx);
    // The CI result message must be shown to the user before re-prompting.
    expect(waitForManualResolve).toHaveBeenCalledWith(ciMessage);
  });

  test("check_conflicts → CONFLICTING → rebase fails → loops back", async () => {
    const checkMergeable = vi
      .fn()
      .mockResolvedValueOnce("MERGEABLE")
      .mockResolvedValueOnce("CONFLICTING");
    const confirmMerge = vi
      .fn()
      .mockResolvedValueOnce("check_conflicts")
      .mockResolvedValueOnce("exit");
    const opts = makeDoneOpts({
      checkMergeable,
      rebaseOntoMain: vi
        .fn()
        .mockResolvedValue({ success: false, message: "conflict" }),
      prompt: { confirmMerge },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    expect(opts.rebaseOntoMain).toHaveBeenCalledOnce();
    // CI not polled because rebase failed.
    expect(opts.pollCiAndFix).not.toHaveBeenCalled();
    // Loop back to confirmMerge, user exits.
    expect(confirmMerge).toHaveBeenCalledTimes(2);
    expect(opts.onNotMerged).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("completed");
  });

  test("check_conflicts respects rebaseAttempted guard across loop-backs", async () => {
    // Flow: initial CONFLICTING → handleConflicting → agent_rebase
    // (rebaseAttempted=true) → afterResolution → MERGEABLE → CI → askMerge.
    // User: "check_conflicts" → CONFLICTING → guard fires (manual resolve)
    // → loop back → "merged".
    const checkMergeable = vi
      .fn()
      .mockResolvedValueOnce("CONFLICTING") // initial mergeableLoop
      .mockResolvedValueOnce("MERGEABLE") // afterResolution
      .mockResolvedValueOnce("MERGEABLE") // afterResolution (CI pass)
      .mockResolvedValueOnce("CONFLICTING"); // inside askMerge
    const handleConflict = vi.fn().mockResolvedValue("agent_rebase");
    const rebaseOntoMain = vi
      .fn()
      .mockResolvedValue({ success: true, message: "ok" });
    const confirmMerge = vi
      .fn()
      .mockResolvedValueOnce("check_conflicts")
      .mockResolvedValueOnce("merged");
    const opts = makeDoneOpts({
      checkMergeable,
      rebaseOntoMain,
      prompt: { handleConflict, confirmMerge },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    // Rebase called only once — the askMerge CONFLICTING path must not
    // trigger a second rebase because the guard is shared.
    expect(rebaseOntoMain).toHaveBeenCalledOnce();
    // waitForManualResolve called for the guard hit inside askMerge.
    expect(opts.prompt.waitForManualResolve).toHaveBeenCalled();
    expect(result.outcome).toBe("completed");
  });

  test("check_conflicts → UNKNOWN → user exits", async () => {
    const checkMergeable = vi
      .fn()
      .mockResolvedValueOnce("MERGEABLE")
      .mockResolvedValueOnce("UNKNOWN");
    const confirmMerge = vi.fn().mockResolvedValueOnce("check_conflicts");
    const handleUnknownMergeable = vi.fn().mockResolvedValue("exit");
    const opts = makeDoneOpts({
      checkMergeable,
      prompt: { confirmMerge, handleUnknownMergeable },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    expect(handleUnknownMergeable).toHaveBeenCalledOnce();
    expect(opts.onNotMerged).toHaveBeenCalledOnce();
    expect(opts.cleanup).not.toHaveBeenCalled();
    expect(result.outcome).toBe("completed");
  });

  test("check_conflicts → UNKNOWN → user rechecks → retries checkMergeable", async () => {
    // Flow: top-level MERGEABLE → askMerge check_conflicts →
    // inner UNKNOWN → recheck → inner MERGEABLE → no-conflicts →
    // confirmMerge merged → cleanup.
    const checkMergeable = vi
      .fn()
      .mockResolvedValueOnce("MERGEABLE") // top-level done stage
      .mockResolvedValueOnce("UNKNOWN") // inner loop 1st attempt
      .mockResolvedValueOnce("MERGEABLE"); // inner loop retry after recheck
    const confirmMerge = vi
      .fn()
      .mockResolvedValueOnce("check_conflicts")
      .mockResolvedValueOnce("merged");
    const handleUnknownMergeable = vi.fn().mockResolvedValue("recheck");
    const waitForManualResolve = vi.fn().mockResolvedValue(undefined);
    const opts = makeDoneOpts({
      checkMergeable,
      prompt: { confirmMerge, handleUnknownMergeable, waitForManualResolve },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    expect(checkMergeable).toHaveBeenCalledTimes(3);
    expect(handleUnknownMergeable).toHaveBeenCalledOnce();
    expect(confirmMerge).toHaveBeenCalledTimes(2);
    expect(opts.cleanup).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("completed");
  });

  test("CONFLICTING: resolve then UNKNOWN routes to unknown-state prompt", async () => {
    // Flow: CONFLICTING → manual resolve → afterResolution →
    // checkMergeable UNKNOWN → handleUnknownMergeable (exit).
    // afterResolution shows the unknown-state prompt directly instead
    // of returning to the outer loop for another full backoff cycle.
    const checkMergeable = vi
      .fn()
      .mockResolvedValueOnce("CONFLICTING")
      .mockResolvedValueOnce("UNKNOWN");
    const handleUnknownMergeable = vi.fn().mockResolvedValue("exit");
    const opts = makeDoneOpts({
      checkMergeable,
      prompt: {
        handleConflict: vi.fn().mockResolvedValue("manual"),
        handleUnknownMergeable,
      },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    // checkMergeable called only 2 times: initial CONFLICTING, then
    // afterResolution UNKNOWN.  No second backoff cycle.
    expect(checkMergeable).toHaveBeenCalledTimes(2);
    // The unknown-state prompt must be shown directly from afterResolution.
    expect(handleUnknownMergeable).toHaveBeenCalledOnce();
    // pollCiAndFix must NOT be called — UNKNOWN was not treated as MERGEABLE.
    expect(opts.pollCiAndFix).not.toHaveBeenCalled();
    // onNotMerged is called because user chose "exit".
    expect(opts.onNotMerged).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("completed");
  });

  // ---- PR already merged short-circuit -----------------------------------

  test("PR already merged at mergeableLoop entry → silent cleanup, no checkMergeable or prompts", async () => {
    const queryPrState = vi.fn().mockResolvedValue("MERGED");
    const opts = makeDoneOpts({ queryPrState });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    expect(queryPrState).toHaveBeenCalledOnce();
    expect(opts.checkMergeable).not.toHaveBeenCalled();
    expect(opts.prompt.confirmMerge).not.toHaveBeenCalled();
    expect(opts.onNotMerged).not.toHaveBeenCalled();
    expect(opts.stopServices).toHaveBeenCalledOnce();
    expect(opts.cleanup).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("already merged");
  });

  test("PR merges during conflict resolution (afterResolution) → silent cleanup, no second checkMergeable", async () => {
    // First guard (mergeableLoop): OPEN → proceed to checkMergeable (CONFLICTING).
    // Handle conflict via manual resolve.  Second guard (afterResolution):
    // MERGED → short-circuit before the post-resolution checkMergeable.
    const queryPrState = vi
      .fn()
      .mockResolvedValueOnce("OPEN")
      .mockResolvedValueOnce("MERGED");
    const checkMergeable = vi.fn().mockResolvedValueOnce("CONFLICTING");
    const waitForManualResolve = vi.fn().mockResolvedValue(undefined);
    const opts = makeDoneOpts({
      queryPrState,
      checkMergeable,
      prompt: {
        handleConflict: vi.fn().mockResolvedValue("manual"),
        waitForManualResolve,
      },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    expect(queryPrState).toHaveBeenCalledTimes(2);
    // checkMergeable called exactly once: the initial CONFLICTING check.
    // The post-resolution re-check must be skipped by the guard.
    expect(checkMergeable).toHaveBeenCalledOnce();
    expect(opts.prompt.confirmMerge).not.toHaveBeenCalled();
    expect(opts.onNotMerged).not.toHaveBeenCalled();
    expect(opts.stopServices).toHaveBeenCalledOnce();
    expect(opts.cleanup).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("already merged");
  });

  test("askMerge check_conflicts: PR merged on GitHub → silent cleanup, no inner checkMergeable", async () => {
    // First guard in mergeableLoop returns OPEN; initial checkMergeable is
    // MERGEABLE; user clicks "check_conflicts".  Inside the inner loop,
    // the guard returns MERGED and short-circuits before checkMergeable
    // runs a second time.
    const queryPrState = vi
      .fn()
      .mockResolvedValueOnce("OPEN")
      .mockResolvedValueOnce("MERGED");
    const checkMergeable = vi.fn().mockResolvedValueOnce("MERGEABLE");
    const confirmMerge = vi.fn().mockResolvedValue("check_conflicts");
    const opts = makeDoneOpts({
      queryPrState,
      checkMergeable,
      prompt: { confirmMerge },
    });
    const stage = createDoneStageHandler(opts);
    const ctx: StageContext = {
      ...BASE_CTX,
      iteration: 0,
      lastAutoIteration: false,
      userInstruction: undefined,
    };
    const result = await stage.handler(ctx);
    expect(queryPrState).toHaveBeenCalledTimes(2);
    // checkMergeable runs only for the outer mergeableLoop; the inner
    // check_conflicts loop must not re-query after the guard fires.
    expect(checkMergeable).toHaveBeenCalledOnce();
    expect(confirmMerge).toHaveBeenCalledOnce();
    expect(opts.onNotMerged).not.toHaveBeenCalled();
    expect(opts.stopServices).toHaveBeenCalledOnce();
    expect(opts.cleanup).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("completed");
    expect(result.message).toContain("already merged");
  });
});

// ---------------------------------------------------------------------------
// AbortSignal cancellation
// ---------------------------------------------------------------------------
describe("AbortSignal cancellation", () => {
  test("pipeline returns cancelled result when aborted before first stage", async () => {
    const controller = new AbortController();
    controller.abort();
    const stages = [
      makeStage(2, async () => ({ outcome: "completed", message: "done" })),
    ];
    const result = await runPipeline(
      makePipelineOpts({ stages, signal: controller.signal }),
    );
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.stoppedAt).toBe(2);
  });

  test("pipeline returns cancelled when aborted during stage execution", async () => {
    const controller = new AbortController();
    let calls = 0;
    const stages = [
      makeStage(2, async () => {
        calls++;
        if (calls === 1) {
          // Abort during first iteration.
          controller.abort();
          return { outcome: "not_approved", message: "loop" };
        }
        return { outcome: "completed", message: "done" };
      }),
    ];
    const result = await runPipeline(
      makePipelineOpts({ stages, signal: controller.signal }),
    );
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(calls).toBe(1);
  });

  test("pipeline does not set cancelled when abort signal is not used", async () => {
    const stages = [
      makeStage(2, async () => ({ outcome: "completed", message: "done" })),
    ];
    const prompt = makePrompt();
    const result = await runPipeline(makePipelineOpts({ stages, prompt }));
    expect(result.success).toBe(true);
    expect(result.cancelled).toBeUndefined();
  });

  test("pipeline stops between stages when aborted", async () => {
    const controller = new AbortController();
    const calls: number[] = [];
    const stages = [
      makeStage(2, async () => {
        calls.push(2);
        controller.abort(); // abort after stage 2 completes
        return { outcome: "completed", message: "" };
      }),
      makeStage(3, async () => {
        calls.push(3);
        return { outcome: "completed", message: "" };
      }),
    ];
    const result = await runPipeline(
      makePipelineOpts({ stages, signal: controller.signal }),
    );
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(calls).toEqual([2]); // stage 3 never ran
  });

  test("step mode: abort during confirmNextStage returns cancelled", async () => {
    const controller = new AbortController();
    const prompt = makePrompt({
      confirmNextStage: vi.fn().mockImplementation(async () => {
        controller.abort();
        return false;
      }),
    });
    const stages = [
      makeStage(2, async () => ({ outcome: "completed", message: "done" })),
    ];
    const result = await runPipeline(
      makePipelineOpts({
        mode: "step",
        stages,
        prompt,
        signal: controller.signal,
      }),
    );
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.stoppedAt).toBe(2);
  });

  test("abort during handleBlocked returns cancelled", async () => {
    const controller = new AbortController();
    const prompt = makePrompt({
      handleBlocked: vi.fn().mockImplementation(async () => {
        controller.abort();
        return { action: "proceed" };
      }),
    });
    const stages = [
      makeStage(2, async () => ({ outcome: "blocked", message: "stuck" })),
    ];
    const result = await runPipeline(
      makePipelineOpts({ stages, prompt, signal: controller.signal }),
    );
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
  });

  test("abort during handleAmbiguous returns cancelled", async () => {
    const controller = new AbortController();
    let calls = 0;
    const prompt = makePrompt({
      handleAmbiguous: vi.fn().mockImplementation(async () => {
        controller.abort();
        return { action: "proceed" };
      }),
    });
    const stages = [
      makeStage(2, async () => {
        calls++;
        return { outcome: "needs_clarification", message: "vague" };
      }),
    ];
    const result = await runPipeline(
      makePipelineOpts({ stages, prompt, signal: controller.signal }),
    );
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    // Two calls: first triggers auto-clarification, second triggers handleAmbiguous.
    expect(calls).toBe(2);
  });

  test("abort during confirmContinueLoop returns cancelled", async () => {
    const controller = new AbortController();
    const prompt = makePrompt({
      confirmContinueLoop: vi.fn().mockImplementation(async () => {
        controller.abort();
        return false;
      }),
    });
    const stages = [
      makeStage(2, async () => ({
        outcome: "not_approved",
        message: "loop",
      })),
    ];
    const result = await runPipeline(
      makePipelineOpts({ stages, prompt, signal: controller.signal }),
    );
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
  });

  test("abort during handler exception skips error prompt", async () => {
    const controller = new AbortController();
    const prompt = makePrompt();
    const stages = [
      makeStage(2, async () => {
        controller.abort();
        throw new Error("killed");
      }),
    ];
    const result = await runPipeline(
      makePipelineOpts({ stages, prompt, signal: controller.signal }),
    );
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    // handleError should not have been called — signal was checked first.
    expect(prompt.handleError).not.toHaveBeenCalled();
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
    expect(opts.checkMergeable).toHaveBeenCalledOnce();
    expect(opts.prompt.confirmMerge).toHaveBeenCalledOnce();
    expect(opts.cleanup).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// startFromStage
// ---------------------------------------------------------------------------
describe("startFromStage", () => {
  test("skips stages before startFromStage", async () => {
    const calls: number[] = [];
    const stages = [
      makeStage(2, async () => {
        calls.push(2);
        return { outcome: "completed", message: "" };
      }),
      makeStage(5, async () => {
        calls.push(5);
        return { outcome: "completed", message: "" };
      }),
      makeStage(8, async () => {
        calls.push(8);
        return { outcome: "completed", message: "" };
      }),
    ];
    const result = await runPipeline(
      makePipelineOpts({ stages, startFromStage: 5 }),
    );
    expect(result.success).toBe(true);
    expect(calls).toEqual([5, 8]);
  });

  test("runs all stages when startFromStage matches first stage", async () => {
    const calls: number[] = [];
    const stages = [
      makeStage(2, async () => {
        calls.push(2);
        return { outcome: "completed", message: "" };
      }),
      makeStage(3, async () => {
        calls.push(3);
        return { outcome: "completed", message: "" };
      }),
    ];
    const result = await runPipeline(
      makePipelineOpts({ stages, startFromStage: 2 }),
    );
    expect(result.success).toBe(true);
    expect(calls).toEqual([2, 3]);
  });

  test("skips all stages when startFromStage exceeds all stage numbers", async () => {
    const calls: number[] = [];
    const stages = [
      makeStage(2, async () => {
        calls.push(2);
        return { outcome: "completed", message: "" };
      }),
    ];
    const result = await runPipeline(
      makePipelineOpts({ stages, startFromStage: 99 }),
    );
    expect(result.success).toBe(true);
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// onStageTransition
// ---------------------------------------------------------------------------
describe("onStageTransition", () => {
  test("called before each stage handler invocation", async () => {
    const transitions: [number, number][] = [];
    const stages = [
      makeStage(2, async () => ({ outcome: "completed", message: "" })),
      makeStage(5, async () => ({ outcome: "completed", message: "" })),
    ];
    await runPipeline(
      makePipelineOpts({
        stages,
        onStageTransition: (stage, loop) => transitions.push([stage, loop]),
      }),
    );
    // Each stage: called once before handler (loop=0), and once after advanceLoop is NOT called
    // because terminal success returns immediately before advanceLoop.
    // So we expect exactly one call per stage at iteration 0.
    expect(transitions).toEqual([
      [2, 0],
      [5, 0],
    ]);
  });

  test("called after loop counter advances on non-terminal outcome", async () => {
    const transitions: [number, number][] = [];
    let callCount = 0;
    const stages = [
      makeStage(2, async () => {
        callCount++;
        if (callCount === 1) {
          return { outcome: "not_approved", message: "needs work" };
        }
        return { outcome: "completed", message: "done" };
      }),
    ];
    await runPipeline(
      makePipelineOpts({
        stages,
        onStageTransition: (stage, loop) => transitions.push([stage, loop]),
      }),
    );
    // Iteration 0: before handler → (2, 0)
    // After not_approved: advanceLoop → iteration becomes 1 → (2, 1)
    // Iteration 1: before handler → (2, 1)
    // Terminal success → return (no advanceLoop)
    expect(transitions).toEqual([
      [2, 0],
      [2, 1],
      [2, 1],
    ]);
  });

  test("stageLoopCount resets to 0 when transitioning between stages", async () => {
    const transitions: [number, number][] = [];
    let stage2Calls = 0;
    const stages = [
      makeStage(2, async () => {
        stage2Calls++;
        if (stage2Calls === 1) {
          return { outcome: "not_approved", message: "loop" };
        }
        return { outcome: "completed", message: "done" };
      }),
      makeStage(3, async () => ({ outcome: "completed", message: "done" })),
    ];
    await runPipeline(
      makePipelineOpts({
        stages,
        onStageTransition: (stage, loop) => transitions.push([stage, loop]),
      }),
    );
    // Stage 2: (2,0), advance→(2,1), (2,1), terminal
    // Stage 3: (3,0), terminal
    expect(transitions).toEqual([
      [2, 0],
      [2, 1],
      [2, 1],
      [3, 0],
    ]);
  });
});

// ---------------------------------------------------------------------------
// startFromStageLoopCount (intra-stage resume)
// ---------------------------------------------------------------------------
describe("startFromStageLoopCount", () => {
  test("restores loop iteration when resuming same stage", async () => {
    const transitions: [number, number][] = [];
    const iterations: number[] = [];
    const stages = [
      makeStage(5, async (ctx) => {
        iterations.push(ctx.iteration);
        return { outcome: "completed", message: "done" };
      }),
    ];
    await runPipeline(
      makePipelineOpts({
        stages,
        startFromStage: 5,
        startFromStageLoopCount: 3,
        onStageTransition: (stage, loop) => transitions.push([stage, loop]),
      }),
    );
    // Handler should receive iteration=3 (restored).
    expect(iterations).toEqual([3]);
    // onStageTransition should fire with restored count.
    expect(transitions).toEqual([[5, 3]]);
  });

  test("does not affect stages after the resume stage", async () => {
    const iterations: [number, number][] = [];
    const stages = [
      makeStage(5, async (ctx) => {
        iterations.push([5, ctx.iteration]);
        return { outcome: "completed", message: "" };
      }),
      makeStage(8, async (ctx) => {
        iterations.push([8, ctx.iteration]);
        return { outcome: "completed", message: "" };
      }),
    ];
    await runPipeline(
      makePipelineOpts({
        stages,
        startFromStage: 5,
        startFromStageLoopCount: 2,
      }),
    );
    // Stage 5 resumes at iteration 2, stage 8 starts fresh at 0.
    expect(iterations).toEqual([
      [5, 2],
      [8, 0],
    ]);
  });

  test("auto-budget is reduced by restored loop count", async () => {
    let callCount = 0;
    const promptMock = makePrompt({
      confirmContinueLoop: vi.fn().mockResolvedValue(false),
    });
    const stages = [
      makeStage(
        5,
        async () => {
          callCount++;
          return { outcome: "not_approved", message: "loop" };
        },
        { autoBudget: 3 },
      ),
    ];
    await runPipeline(
      makePipelineOpts({
        stages,
        prompt: promptMock,
        startFromStage: 5,
        startFromStageLoopCount: 2,
      }),
    );
    // Budget is 3. Restored iteration is 2. autoRemaining = max(1, 3-2) = 1.
    // First call runs at iteration 2, then advanceLoop makes autoRemaining 0.
    // User declines to continue → abort.
    expect(callCount).toBe(1);
    expect(promptMock.confirmContinueLoop).toHaveBeenCalledOnce();
  });

  test("ignored when startFromStage is not set", async () => {
    const iterations: number[] = [];
    const stages = [
      makeStage(2, async (ctx) => {
        iterations.push(ctx.iteration);
        return { outcome: "completed", message: "" };
      }),
    ];
    await runPipeline(
      makePipelineOpts({
        stages,
        startFromStageLoopCount: 5,
      }),
    );
    // Without startFromStage, loop count should start at 0.
    expect(iterations).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// onSessionId
// ---------------------------------------------------------------------------
describe("onSessionId", () => {
  test("passes onSessionId callback through to StageContext", async () => {
    const sessionCalls: [string, string][] = [];
    const stages = [
      makeStage(2, async (ctx) => {
        ctx.onSessionId?.("a", "sess-impl-1");
        return { outcome: "completed", message: "" };
      }),
    ];
    await runPipeline(
      makePipelineOpts({
        stages,
        onSessionId: (agent, sid) => sessionCalls.push([agent, sid]),
      }),
    );
    expect(sessionCalls).toEqual([["a", "sess-impl-1"]]);
  });

  test("captures session IDs from multiple stages and agents", async () => {
    const sessionCalls: [string, string][] = [];
    const stages = [
      makeStage(2, async (ctx) => {
        ctx.onSessionId?.("a", "sess-a-1");
        return { outcome: "completed", message: "" };
      }),
      makeStage(8, async (ctx) => {
        ctx.onSessionId?.("b", "sess-b-1");
        ctx.onSessionId?.("a", "sess-a-2");
        return { outcome: "completed", message: "" };
      }),
    ];
    await runPipeline(
      makePipelineOpts({
        stages,
        onSessionId: (agent, sid) => sessionCalls.push([agent, sid]),
      }),
    );
    expect(sessionCalls).toEqual([
      ["a", "sess-a-1"],
      ["b", "sess-b-1"],
      ["a", "sess-a-2"],
    ]);
  });

  test("onSessionId is optional — stages work without it", async () => {
    const stages = [
      makeStage(2, async (ctx) => {
        // Should not throw even without onSessionId.
        ctx.onSessionId?.("a", "sess-1");
        return { outcome: "completed", message: "" };
      }),
    ];
    const result = await runPipeline(makePipelineOpts({ stages }));
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E2E: full resume cycle
// ---------------------------------------------------------------------------
describe("full resume cycle (E2E)", () => {
  test("pipeline halts, state captured, resumed from correct stage and loop", async () => {
    const transitions: [number, number][] = [];
    let stage5Calls = 0;

    // First run: stage 2 completes, stage 5 loops once then user aborts.
    const prompt1 = makePrompt({
      confirmContinueLoop: vi.fn().mockResolvedValue(false),
    });
    const makeStage5Handler = () =>
      makeStage(
        5,
        async () => {
          stage5Calls++;
          return { outcome: "not_approved", message: "CI fail" };
        },
        { autoBudget: 1 },
      );

    const result1 = await runPipeline(
      makePipelineOpts({
        stages: [
          makeStage(2, async () => ({ outcome: "completed", message: "" })),
          makeStage5Handler(),
        ],
        prompt: prompt1,
        onStageTransition: (s, l) => transitions.push([s, l]),
      }),
    );

    expect(result1.success).toBe(false);
    expect(result1.stoppedAt).toBe(5);

    // Extract last transition to simulate saved state.
    const lastTransition = transitions[transitions.length - 1];
    expect(lastTransition[0]).toBe(5); // stage 5
    expect(lastTransition[1]).toBe(1); // loop count 1

    // Second run: resume from stage 5, loop count 1.
    const transitions2: [number, number][] = [];
    stage5Calls = 0;

    const result2 = await runPipeline(
      makePipelineOpts({
        stages: [
          makeStage(2, async () => ({ outcome: "completed", message: "" })),
          makeStage(5, async () => {
            stage5Calls++;
            return { outcome: "completed", message: "CI pass now" };
          }),
          makeStage(8, async () => ({ outcome: "completed", message: "" })),
        ],
        startFromStage: 5,
        startFromStageLoopCount: 1,
        onStageTransition: (s, l) => transitions2.push([s, l]),
      }),
    );

    expect(result2.success).toBe(true);
    // Stage 2 was skipped (startFromStage: 5).
    // Stage 5 resumed at iteration 1, completed immediately.
    // Stage 8 started fresh at iteration 0.
    expect(stage5Calls).toBe(1);
    expect(transitions2).toEqual([
      [5, 1], // stage 5 at restored iteration
      [8, 0], // stage 8 fresh
    ]);
  });

  test("pipeline saves review round via onStageTransition in stage 7", async () => {
    const transitions: [number, number][] = [];
    let reviewCalls = 0;

    const stages = [
      makeStage(7, async () => {
        reviewCalls++;
        if (reviewCalls <= 2) {
          return { outcome: "not_approved", message: "needs work" };
        }
        return { outcome: "completed", message: "approved" };
      }),
    ];
    await runPipeline(
      makePipelineOpts({
        stages,
        onStageTransition: (s, l) => transitions.push([s, l]),
      }),
    );

    // 3 iterations: calls at (7,0), advance→(7,1), (7,1), advance→(7,2), (7,2), terminal
    expect(transitions).toEqual([
      [7, 0],
      [7, 1],
      [7, 1],
      [7, 2],
      [7, 2],
    ]);
    // A caller can derive reviewRound = loopCount + 1.
  });

  test("saved session IDs are passed to resumed stage handler and cleared after", async () => {
    const receivedSessions: {
      a: string | undefined;
      b: string | undefined;
    }[] = [];
    const stages = [
      makeStage(5, async (ctx) => {
        receivedSessions.push({
          a: ctx.savedAgentASessionId,
          b: ctx.savedAgentBSessionId,
        });
        return { outcome: "completed", message: "" };
      }),
      makeStage(8, async (ctx) => {
        receivedSessions.push({
          a: ctx.savedAgentASessionId,
          b: ctx.savedAgentBSessionId,
        });
        return { outcome: "completed", message: "" };
      }),
    ];
    await runPipeline(
      makePipelineOpts({
        stages,
        startFromStage: 5,
        savedAgentASessionId: "sess-a-saved",
        savedAgentBSessionId: "sess-b-saved",
      }),
    );
    // Stage 5 (resume stage) should receive saved session IDs.
    expect(receivedSessions[0]).toEqual({
      a: "sess-a-saved",
      b: "sess-b-saved",
    });
    // Stage 8 (after resume) should NOT receive saved session IDs.
    expect(receivedSessions[1]).toEqual({
      a: undefined,
      b: undefined,
    });
  });

  test("saved session IDs are cleared after first invocation within same stage", async () => {
    const receivedSessions: (string | undefined)[] = [];
    let callCount = 0;
    const stages = [
      makeStage(5, async (ctx) => {
        receivedSessions.push(ctx.savedAgentASessionId);
        callCount++;
        if (callCount === 1) {
          return { outcome: "not_approved", message: "loop" };
        }
        return { outcome: "completed", message: "" };
      }),
    ];
    await runPipeline(
      makePipelineOpts({
        stages,
        startFromStage: 5,
        savedAgentASessionId: "sess-a-saved",
      }),
    );
    // First call has saved session, second call does not.
    expect(receivedSessions).toEqual(["sess-a-saved", undefined]);
  });

  test("restart_from jump is checkpointed via onStageTransition", async () => {
    const transitions: [number, number][] = [];
    const stages = [
      makeStage(5, async () => ({ outcome: "completed", message: "" })),
      makeStage(
        6,
        async () => ({ outcome: "not_approved", message: "test fail" }),
        { restartFromStage: 5 },
      ),
    ];
    const prompt = makePrompt({
      confirmContinueLoop: vi.fn().mockResolvedValue(false),
    });
    await runPipeline(
      makePipelineOpts({
        stages,
        prompt,
        onStageTransition: (s, l) => transitions.push([s, l]),
      }),
    );
    // Stage 5 entry: (5,0)
    // Stage 6 entry: (6,0)
    // Stage 6 returns restart_from 5 → checkpoint: (5,0)
    // Stage 5 re-entry: (5,0)
    // Stage 6 re-entry: (6,0)
    // Stage 6 returns restart_from again → checkpoint: (5,0)
    // Budget exhausted → confirmContinueLoop → user declines
    expect(transitions).toContainEqual([5, 0]);
    // Verify the jump target is checkpointed (not just the source stage).
    const jumpCheckpoints = transitions.filter(
      ([s, l], idx) =>
        s === 5 && l === 0 && idx > 0 && transitions[idx - 1][0] === 6,
    );
    expect(jumpCheckpoints.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Pipeline event emitter integration
// ---------------------------------------------------------------------------

describe("pipeline event emission", () => {
  test("emits stage:enter before handler and stage:exit after handler", async () => {
    const timeline: string[] = [];
    const emitter = new PipelineEventEmitter();
    emitter.on("stage:enter", () => timeline.push("enter"));
    emitter.on("stage:exit", () => timeline.push("exit"));

    const stages = [
      makeStage(1, async () => {
        timeline.push("handler");
        return { outcome: "completed", message: "" };
      }),
    ];

    await runPipeline(makePipelineOpts({ stages, events: emitter }));

    expect(timeline).toEqual(["enter", "handler", "exit"]);
  });

  test("stage:enter includes stageNumber, stageName, and iteration", async () => {
    const emitter = new PipelineEventEmitter();
    const enterEvents: StageEnterEvent[] = [];
    emitter.on("stage:enter", (ev) => enterEvents.push(ev));

    const stages = [
      makeStage(5, async () => ({ outcome: "completed", message: "" })),
    ];

    await runPipeline(makePipelineOpts({ stages, events: emitter }));

    expect(enterEvents).toEqual([
      { stageNumber: 5, stageName: "Stage 5", iteration: 0 },
    ]);
  });

  test("stage:exit includes stageNumber and outcome", async () => {
    const emitter = new PipelineEventEmitter();
    const exitEvents: StageExitEvent[] = [];
    emitter.on("stage:exit", (ev) => exitEvents.push(ev));

    const stages = [
      makeStage(2, async () => ({ outcome: "completed", message: "" })),
    ];

    await runPipeline(makePipelineOpts({ stages, events: emitter }));

    expect(exitEvents).toEqual([{ stageNumber: 2, outcome: "completed" }]);
  });

  test("emits events for each stage in sequence", async () => {
    const emitter = new PipelineEventEmitter();
    const events: string[] = [];
    emitter.on("stage:enter", (ev) => events.push(`enter:${ev.stageNumber}`));
    emitter.on("stage:exit", (ev) => events.push(`exit:${ev.stageNumber}`));

    const stages = [
      makeStage(1, async () => ({ outcome: "completed", message: "" })),
      makeStage(2, async () => ({ outcome: "completed", message: "" })),
      makeStage(3, async () => ({ outcome: "completed", message: "" })),
    ];

    await runPipeline(makePipelineOpts({ stages, events: emitter }));

    expect(events).toEqual([
      "enter:1",
      "exit:1",
      "enter:2",
      "exit:2",
      "enter:3",
      "exit:3",
    ]);
  });

  test("emits stage:enter on each loop iteration with incrementing iteration", async () => {
    const emitter = new PipelineEventEmitter();
    const enterEvents: StageEnterEvent[] = [];
    emitter.on("stage:enter", (ev) => enterEvents.push(ev));

    let call = 0;
    const stages = [
      makeStage(
        4,
        async () => {
          call++;
          // First two iterations return not_approved, third completes.
          if (call < 3) return { outcome: "not_approved", message: "" };
          return { outcome: "completed", message: "" };
        },
        { autoBudget: 5 },
      ),
    ];

    await runPipeline(makePipelineOpts({ stages, events: emitter }));

    expect(enterEvents).toEqual([
      { stageNumber: 4, stageName: "Stage 4", iteration: 0 },
      { stageNumber: 4, stageName: "Stage 4", iteration: 1 },
      { stageNumber: 4, stageName: "Stage 4", iteration: 2 },
    ]);
  });

  test("emits stage:exit with not_approved on loop iterations", async () => {
    const emitter = new PipelineEventEmitter();
    const exitEvents: StageExitEvent[] = [];
    emitter.on("stage:exit", (ev) => exitEvents.push(ev));

    let call = 0;
    const stages = [
      makeStage(
        3,
        async () => {
          call++;
          if (call < 3) return { outcome: "not_approved", message: "" };
          return { outcome: "completed", message: "" };
        },
        { autoBudget: 5 },
      ),
    ];

    await runPipeline(makePipelineOpts({ stages, events: emitter }));

    expect(exitEvents).toEqual([
      { stageNumber: 3, outcome: "not_approved" },
      { stageNumber: 3, outcome: "not_approved" },
      { stageNumber: 3, outcome: "completed" },
    ]);
  });

  test("streamSinks are passed to stage context when events are provided", async () => {
    const emitter = new PipelineEventEmitter();
    let capturedSinks: StageContext["streamSinks"];

    const stages = [
      makeStage(1, async (ctx) => {
        capturedSinks = ctx.streamSinks;
        return { outcome: "completed", message: "" };
      }),
    ];

    await runPipeline(makePipelineOpts({ stages, events: emitter }));

    expect(capturedSinks).toBeDefined();
    expect(typeof capturedSinks?.a).toBe("function");
    expect(typeof capturedSinks?.b).toBe("function");
  });

  test("streamSinks emit agent:chunk events on the emitter", async () => {
    const emitter = new PipelineEventEmitter();
    const chunks: { agent: string; chunk: string }[] = [];
    emitter.on("agent:chunk", (ev) => chunks.push(ev));

    const stages = [
      makeStage(1, async (ctx) => {
        ctx.streamSinks?.a("hello from A");
        ctx.streamSinks?.b("hello from B");
        return { outcome: "completed", message: "" };
      }),
    ];

    await runPipeline(makePipelineOpts({ stages, events: emitter }));

    expect(chunks).toEqual([
      { agent: "a", chunk: "hello from A" },
      { agent: "b", chunk: "hello from B" },
    ]);
  });

  test("streamSinks are undefined when events option is omitted", async () => {
    let capturedSinks: StageContext["streamSinks"];

    const stages = [
      makeStage(1, async (ctx) => {
        capturedSinks = ctx.streamSinks;
        return { outcome: "completed", message: "" };
      }),
    ];

    await runPipeline(makePipelineOpts({ stages }));

    expect(capturedSinks).toBeUndefined();
  });

  test("stage:exit emits blocked outcome when user halts", async () => {
    const emitter = new PipelineEventEmitter();
    const exitEvents: StageExitEvent[] = [];
    emitter.on("stage:exit", (ev) => exitEvents.push(ev));

    const prompt = makePrompt({
      handleBlocked: vi.fn().mockResolvedValue({ action: "halt" }),
    });

    const stages = [
      makeStage(2, async () => ({
        outcome: "blocked",
        message: "stuck",
      })),
    ];

    await runPipeline(makePipelineOpts({ stages, events: emitter, prompt }));

    expect(exitEvents).toEqual([{ stageNumber: 2, outcome: "blocked" }]);
  });

  test("stage:exit emits error outcome", async () => {
    const emitter = new PipelineEventEmitter();
    const exitEvents: StageExitEvent[] = [];
    emitter.on("stage:exit", (ev) => exitEvents.push(ev));

    const prompt = makePrompt({
      handleError: vi.fn().mockResolvedValue({ action: "abort" }),
    });

    const stages = [
      makeStage(1, async () => ({ outcome: "error", message: "boom" })),
    ];

    await runPipeline(makePipelineOpts({ stages, events: emitter, prompt }));

    expect(exitEvents).toEqual([{ stageNumber: 1, outcome: "error" }]);
  });
});
