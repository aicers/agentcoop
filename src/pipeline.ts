/**
 * Pipeline engine — stage registration, dispatch, loop control, and
 * execution modes.
 *
 * The engine drives a 9-stage pipeline.  Each stage is implemented by a
 * `StageHandler` registered at construction time.  This module owns the
 * control flow (looping, user prompts, blocked/error handling) but does
 * **not** contain stage-specific prompts — those live in separate handler
 * modules (issues #6, #7, #8).
 */

import { buildClarificationPrompt } from "./step-parser.js";

// ---- public types --------------------------------------------------------

export type ExecutionMode = "auto" | "step";

/**
 * Outcome of a single handler invocation inside a loop iteration.
 */
export type StageOutcome =
  | "completed"
  | "fixed"
  | "approved"
  | "not_approved"
  | "blocked"
  | "needs_clarification"
  | "error";

/**
 * What the user chose when an agent is blocked or an error occurs.
 */
export type UserAction =
  | "proceed"
  | "instruct"
  | "halt"
  | "retry"
  | "skip"
  | "abort";

export interface StageResult {
  outcome: StageOutcome;
  /** Free-form message shown to the user or forwarded to the next stage. */
  message: string;
}

/**
 * A stage handler is an async function that performs the work for a
 * single pipeline stage.  It receives context about the current run and
 * returns a `StageResult`.
 */
export type StageHandler = (ctx: StageContext) => Promise<StageResult>;

export interface StageDefinition {
  /** Human-readable name, e.g. "Implementation". */
  name: string;
  /** 1-based stage number (1–9). */
  number: number;
  handler: StageHandler;
  /**
   * When true the "Proceed" option is **not** offered when the agent
   * reports BLOCKED — the artifact is mandatory (e.g. PR creation).
   */
  requiresArtifact?: boolean;
  /**
   * Override the default auto-iteration budget for this stage's loop.
   * When omitted the engine uses its built-in default (3).
   */
  autoBudget?: number;
  /**
   * When set, a `"not_approved"` outcome causes the pipeline to jump
   * back to the given stage number instead of looping within this
   * stage.  The target must be an earlier stage (backward jump only).
   *
   * Example: stage 6 (test plan verification) sets
   * `restartFromStage: 5` so that code changes are re-validated by
   * the CI check before re-entering verification.
   */
  restartFromStage?: number;
}

/**
 * Context passed into every stage handler.
 */
export interface StageContext {
  owner: string;
  repo: string;
  issueNumber: number;
  branch: string;
  worktreePath: string;
  /** Current loop iteration (0-based). */
  iteration: number;
  /**
   * `true` when this is the last iteration before the auto-budget is
   * exhausted and the user will be prompted to continue.
   */
  lastAutoIteration: boolean;
  /** Instruction injected by the user after a "instruct" action. */
  userInstruction: string | undefined;
}

// ---- user interaction interface ------------------------------------------

/**
 * Abstraction for user-facing prompts so the engine can be tested
 * without a real TTY.
 */
export interface UserPrompt {
  /**
   * Ask the user to approve continuing after the automatic loop budget
   * is exhausted.
   */
  confirmContinueLoop(stageName: string, iteration: number): Promise<boolean>;

  /**
   * Ask the user to approve advancing to the next stage (step mode).
   */
  confirmNextStage(stageName: string): Promise<boolean>;

  /**
   * Present a blocked agent's response and let the user choose.
   * `allowProceed` is false for required-artifact stages.
   */
  handleBlocked(
    message: string,
    allowProceed: boolean,
  ): Promise<{ action: UserAction; instruction?: string }>;

  /**
   * Present an error to the user and let them choose Retry / Skip / Abort.
   */
  handleError(
    message: string,
  ): Promise<{ action: Extract<UserAction, "retry" | "skip" | "abort"> }>;

  /**
   * Show the agent's response to the user when clarification has failed
   * after a retry, and let the user decide.
   */
  handleAmbiguous(
    message: string,
  ): Promise<{ action: UserAction; instruction?: string }>;

  /**
   * Ask user to confirm merge and final cleanup (stage 9).
   */
  confirmMerge(message: string): Promise<boolean>;

  /**
   * Report completion to the user (stage 9).
   */
  reportCompletion(message: string): Promise<void>;
}

// ---- loop control --------------------------------------------------------

/** Default number of automatic iterations before asking the user. */
const DEFAULT_AUTO_BUDGET = 3;

export interface LoopControl {
  /** Current iteration (0-based). */
  iteration: number;
  /** Number of auto-iterations remaining before the next user prompt. */
  autoRemaining: number;
  /** Budget granted on each reset. */
  budget: number;
}

/**
 * Create a fresh loop-control state.
 */
export function createLoopControl(budget = DEFAULT_AUTO_BUDGET): LoopControl {
  return { iteration: 0, autoRemaining: budget, budget };
}

/**
 * Advance the loop counter by one.  Returns `true` if the loop may
 * continue automatically, `false` if user approval is needed.
 */
export function advanceLoop(lc: LoopControl): boolean {
  lc.iteration += 1;
  lc.autoRemaining -= 1;
  return lc.autoRemaining > 0;
}

/**
 * Grant a new budget of automatic iterations (called after user
 * approves continuing).
 */
export function grantLoopBudget(lc: LoopControl): void {
  lc.autoRemaining = lc.budget;
}

// ---- terminal outcomes ---------------------------------------------------

const TERMINAL_OUTCOMES = new Set<StageOutcome>([
  "completed",
  "fixed",
  "approved",
]);

/**
 * Whether the outcome means the stage is finished successfully and the
 * pipeline should move on to the next stage.
 */
export function isTerminalSuccess(outcome: StageOutcome): boolean {
  return TERMINAL_OUTCOMES.has(outcome);
}

// ---- pipeline engine -----------------------------------------------------

export interface PipelineOptions {
  mode: ExecutionMode;
  stages: StageDefinition[];
  prompt: UserPrompt;
  /** Shared context fields injected into every `StageContext`. */
  context: Omit<
    StageContext,
    "iteration" | "lastAutoIteration" | "userInstruction"
  >;
}

export interface PipelineResult {
  /** Whether the entire pipeline completed successfully. */
  success: boolean;
  /** The stage number where the pipeline stopped (on abort/halt). */
  stoppedAt: number | undefined;
  message: string;
}

/**
 * Run the full pipeline from stage 1 through stage 9.
 */
export async function runPipeline(
  options: PipelineOptions,
): Promise<PipelineResult> {
  const { mode, stages, prompt, context } = options;

  // Sort stages by number to guarantee order.
  const sorted = [...stages].sort((a, b) => a.number - b.number);

  // Validate restartFromStage references at startup.
  const stageNumbers = new Set(sorted.map((s) => s.number));
  for (const stage of sorted) {
    if (stage.restartFromStage !== undefined) {
      if (!stageNumbers.has(stage.restartFromStage)) {
        throw new Error(
          `Stage ${stage.number} (${stage.name}) has invalid ` +
            `restartFromStage: stage ${stage.restartFromStage} does not exist.`,
        );
      }
      if (stage.restartFromStage >= stage.number) {
        throw new Error(
          `Stage ${stage.number} (${stage.name}) has invalid ` +
            `restartFromStage: ${stage.restartFromStage} is not an earlier stage.`,
        );
      }
    }
  }

  // Pipeline-level restart budget: tracks consecutive restarts per
  // originating stage so the "3 auto / 4th asks user" contract holds
  // across backward jumps.
  const restartCounts = new Map<number, LoopControl>();

  let i = 0;
  while (i < sorted.length) {
    const stage = sorted[i];

    // In step mode, ask the user before entering each stage.
    if (mode === "step") {
      const ok = await prompt.confirmNextStage(stage.name);
      if (!ok) {
        return {
          success: false,
          stoppedAt: stage.number,
          message: `User skipped stage ${stage.number} (${stage.name}).`,
        };
      }
    }

    const result = await runStage(stage, context, prompt);

    if (result.action === "abort") {
      return {
        success: false,
        stoppedAt: stage.number,
        message: result.message,
      };
    }

    if (result.action === "restart_from") {
      const targetIdx = sorted.findIndex(
        (s) => s.number === result.restartFromStage,
      );

      if (targetIdx === -1 || targetIdx >= i) {
        return {
          success: false,
          stoppedAt: stage.number,
          message: `Invalid restart target: stage ${result.restartFromStage}.`,
        };
      }

      // Pipeline-level budget for restarts originating from this stage.
      let lc = restartCounts.get(stage.number);
      if (!lc) {
        lc = createLoopControl(stage.autoBudget);
        restartCounts.set(stage.number, lc);
      }

      const canContinue = advanceLoop(lc);
      if (!canContinue) {
        const approved = await prompt.confirmContinueLoop(
          stage.name,
          lc.iteration,
        );
        if (!approved) {
          return {
            success: false,
            stoppedAt: stage.number,
            message: `User declined to continue restart loop at iteration ${lc.iteration}.`,
          };
        }
        grantLoopBudget(lc);
      }

      i = targetIdx;
      continue;
    }

    // "done" and "skip" advance to the next stage.
    // Clear restart budget when a stage completes normally.
    restartCounts.delete(stage.number);
    i++;
  }

  return {
    success: true,
    stoppedAt: undefined,
    message: "Pipeline completed successfully.",
  };
}

// ---- single-stage runner -------------------------------------------------

interface StageRunResult {
  action: "done" | "skip" | "abort" | "restart_from";
  message: string;
  /** Target stage number — only set when action is `"restart_from"`. */
  restartFromStage?: number;
}

/**
 * Dispatch a user-facing error and return the appropriate run result,
 * or `undefined` to signal a retry.
 */
async function dispatchError(
  prompt: UserPrompt,
  message: string,
): Promise<StageRunResult | undefined> {
  const decision = await prompt.handleError(message);
  if (decision.action === "retry") return undefined;
  if (decision.action === "skip") return { action: "skip", message };
  return { action: "abort", message };
}

async function runStage(
  stage: StageDefinition,
  baseCtx: Omit<
    StageContext,
    "iteration" | "lastAutoIteration" | "userInstruction"
  >,
  prompt: UserPrompt,
): Promise<StageRunResult> {
  const lc = createLoopControl(stage.autoBudget);
  let userInstruction: string | undefined;
  /** Tracks whether the last iteration was an auto-clarification retry. */
  let clarificationAttempted = false;

  while (true) {
    const ctx: StageContext = {
      ...baseCtx,
      iteration: lc.iteration,
      lastAutoIteration: lc.autoRemaining === 1,
      userInstruction,
    };

    // Clear the one-shot instruction after use.
    userInstruction = undefined;

    let result: StageResult;
    try {
      result = await stage.handler(ctx);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const dispatched = await dispatchError(prompt, errMsg);
      if (dispatched === undefined) continue; // retry
      return dispatched;
    }

    // ---- evaluate outcome ------------------------------------------------

    if (isTerminalSuccess(result.outcome)) {
      return { action: "done", message: result.message };
    }

    if (result.outcome === "not_approved") {
      if (stage.restartFromStage !== undefined) {
        // Bubble up to the pipeline for a backward stage transition.
        return {
          action: "restart_from",
          message: result.message,
          restartFromStage: stage.restartFromStage,
        };
      }
      // Treat as needing another loop iteration with feedback.
      userInstruction = result.message;
      clarificationAttempted = false;
    } else if (result.outcome === "blocked") {
      clarificationAttempted = false;
      const decision = await prompt.handleBlocked(
        result.message,
        !stage.requiresArtifact,
      );
      if (decision.action === "halt") {
        return { action: "abort", message: "User halted on blocked agent." };
      }
      if (decision.action === "proceed") {
        return { action: "done", message: result.message };
      }
      if (decision.action === "instruct") {
        userInstruction = decision.instruction;
      }
    } else if (result.outcome === "needs_clarification") {
      if (!clarificationAttempted) {
        // First ambiguous response: auto-retry with a clarification prompt.
        clarificationAttempted = true;
        userInstruction = buildClarificationPrompt(result.message);
      } else {
        // Clarification already tried once — fall back to user.
        clarificationAttempted = false;
        const decision = await prompt.handleAmbiguous(result.message);
        if (decision.action === "halt") {
          return {
            action: "abort",
            message: "User halted on ambiguous response.",
          };
        }
        if (decision.action === "proceed") {
          return { action: "done", message: result.message };
        }
        if (decision.action === "instruct") {
          userInstruction = decision.instruction;
        }
      }
    } else if (result.outcome === "error") {
      clarificationAttempted = false;
      const dispatched = await dispatchError(prompt, result.message);
      if (dispatched === undefined) continue; // retry
      return dispatched;
    }

    // ---- loop control ----------------------------------------------------

    const canContinue = advanceLoop(lc);
    if (!canContinue) {
      const approved = await prompt.confirmContinueLoop(
        stage.name,
        lc.iteration,
      );
      if (!approved) {
        return {
          action: "abort",
          message: `User declined to continue loop at iteration ${lc.iteration}.`,
        };
      }
      grantLoopBudget(lc);
    }
  }
}

// ---- Stage 9: Done -------------------------------------------------------

/**
 * Built-in stage-9 handler.  Reports completion, waits for the user to
 * confirm merge, then cleans up the worktree.
 *
 * Callbacks are injected so the handler stays independent of the
 * worktree module, keeping the engine testable.
 */
export function createDoneStageHandler(options: {
  /** Called to report completion before asking about merge. */
  reportCompletion: (message: string) => Promise<void>;
  /** Called to ask the user whether the PR has been merged. */
  confirmMerge: (message: string) => Promise<boolean>;
  /** Called to remove the worktree after merge is confirmed. */
  cleanup: () => void;
}): StageDefinition {
  return {
    name: "Done",
    number: 9,
    handler: async (ctx) => {
      const summary = `Pipeline for ${ctx.owner}/${ctx.repo}#${ctx.issueNumber} completed.`;
      await options.reportCompletion(summary);

      const merged = await options.confirmMerge(
        "Has the PR been merged? Confirm to clean up the worktree.",
      );

      if (merged) {
        options.cleanup();
        return {
          outcome: "completed",
          message: `${summary} Worktree cleaned up.`,
        };
      }

      return {
        outcome: "completed",
        message: `${summary} Worktree preserved (merge not confirmed).`,
      };
    },
  };
}
