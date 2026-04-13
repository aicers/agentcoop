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

import { t } from "./i18n/index.js";
import type { PipelineEventEmitter } from "./pipeline-events.js";
import type { PromptSink, StreamSink, UsageSink } from "./stage-util.js";
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
  /** Title of the GitHub issue (used for display in the StatusBar). */
  issueTitle?: string;
  branch: string;
  worktreePath: string;
  /**
   * Full SHA of the base commit (tip of origin/{defaultBranch} when the
   * worktree was created).  Used by the squash stage to limit the
   * squash range to only the commits introduced on this branch.
   */
  baseSha?: string;
  /** Current loop iteration (0-based). */
  iteration: number;
  /**
   * `true` when this is the last iteration before the auto-budget is
   * exhausted and the user will be prompted to continue.
   */
  lastAutoIteration: boolean;
  /** Instruction injected by the user after a "instruct" action. */
  userInstruction: string | undefined;
  /**
   * Callback for stage handlers to report agent session IDs so they
   * can be persisted for resume.  `agent` is `"a"` or `"b"`.
   */
  onSessionId?: (agent: "a" | "b", sessionId: string) => void;
  /**
   * Saved session IDs from a prior run, passed on resume so stage
   * handlers can `resume()` instead of `invoke()` on first call.
   */
  savedAgentASessionId?: string;
  savedAgentBSessionId?: string;
  /**
   * Optional sinks for real-time agent output streaming.  Stage handlers
   * forward these to `invokeOrResume` / `sendFollowUp` so that output
   * chunks are emitted as they arrive.
   */
  streamSinks?: { a?: StreamSink; b?: StreamSink };
  /**
   * Optional sinks for displaying outgoing prompts in the UI.  Stage
   * handlers call these before sending a prompt to the agent so the
   * user can see what the agent was asked to do.
   */
  promptSinks?: { a?: PromptSink; b?: PromptSink };
  /**
   * Optional sinks for reporting token usage after an agent invocation.
   * Stage handlers call these with the usage data from `AgentResult`
   * so the UI can display per-agent token consumption.
   */
  usageSinks?: { a?: UsageSink; b?: UsageSink };
  /**
   * Abort signal for cancellation.  Stage handlers can check this after
   * async operations to bail out early when the user presses Ctrl+C.
   */
  signal?: AbortSignal;
}

// ---- user interaction interface ------------------------------------------

/**
 * Abstraction for user-facing prompts so the engine can be tested
 * without a real TTY.
 */
export interface UserPrompt {
  /**
   * Ask the user to approve continuing after the automatic loop budget
   * is exhausted.  `message` carries the last stage result (e.g. an
   * unresolved-items summary) so it can be shown before the prompt.
   */
  confirmContinueLoop(
    stageName: string,
    iteration: number,
    message: string,
  ): Promise<boolean>;

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
   * - `"merged"` — user confirms the PR has been merged.
   * - `"check_conflicts"` — check for conflicts and rebase if needed.
   * - `"exit"` — stop asking and proceed to cleanup options.
   */
  confirmMerge(message: string): Promise<"merged" | "check_conflicts" | "exit">;

  /**
   * Present a conflict notification and let the user choose between
   * agent rebase and manual resolution (stage 9).
   */
  handleConflict(message: string): Promise<"agent_rebase" | "manual">;

  /**
   * Notify the user that the mergeable state could not be determined
   * and let them choose to re-check or exit (stage 9).
   */
  handleUnknownMergeable(message: string): Promise<"recheck" | "exit">;

  /**
   * Wait for the user to signal that they have finished manual
   * conflict resolution (stage 9).
   */
  waitForManualResolve(message: string): Promise<void>;

  /**
   * Ask user to confirm a cleanup action (e.g. stop services, delete
   * worktree).  Used in stage 9 "not merged" path.
   */
  confirmCleanup(message: string): Promise<boolean>;
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
    | "iteration"
    | "lastAutoIteration"
    | "userInstruction"
    | "onSessionId"
    | "savedAgentASessionId"
    | "savedAgentBSessionId"
    | "streamSinks"
    | "promptSinks"
  >;
  /**
   * When set, stages with a number strictly less than this value are
   * skipped.  Used to resume a pipeline from a saved checkpoint.
   */
  startFromStage?: number;
  /**
   * When resuming mid-stage, set this to the saved `stageLoopCount` so
   * the loop control picks up where it left off.  Only meaningful when
   * `startFromStage` is also set.
   */
  startFromStageLoopCount?: number;
  /**
   * Called before each stage handler invocation and after every
   * loop-counter change, so the caller can persist progress.
   *
   * @param stageNumber - The 1-based stage number about to run.
   * @param stageLoopCount - The current loop iteration within the stage.
   */
  onStageTransition?: (stageNumber: number, stageLoopCount: number) => void;
  /**
   * Called by stage handlers when they receive an agent session ID.
   * Wired into `StageContext.onSessionId` for each handler invocation.
   */
  onSessionId?: (agent: "a" | "b", sessionId: string) => void;
  /**
   * Saved session IDs from a prior run.  Passed into `StageContext` on
   * the first handler invocation of the resumed stage so handlers can
   * `resume()` an existing agent conversation.  Cleared after the first
   * invocation to prevent stale sessions from leaking into later stages.
   */
  savedAgentASessionId?: string;
  savedAgentBSessionId?: string;
  /**
   * Event emitter for the TUI.  When provided, stage lifecycle and
   * agent-chunk events are emitted so the UI can render in real time.
   */
  events?: PipelineEventEmitter;
  /**
   * When provided, the pipeline checks this signal before each stage
   * and handler invocation.  If aborted, the pipeline returns early
   * with `cancelled: true`.
   */
  signal?: AbortSignal;
}

export interface PipelineResult {
  /** Whether the entire pipeline completed successfully. */
  success: boolean;
  /** The stage number where the pipeline stopped (on abort/halt). */
  stoppedAt: number | undefined;
  message: string;
  /** True when the pipeline was stopped via an AbortSignal (Ctrl+C). */
  cancelled?: boolean;
}

/**
 * Run the full pipeline from stage 1 through stage 9.
 */
export async function runPipeline(
  options: PipelineOptions,
): Promise<PipelineResult> {
  const {
    mode,
    stages,
    prompt,
    context,
    startFromStage,
    startFromStageLoopCount,
    onStageTransition,
    onSessionId,
    savedAgentASessionId,
    savedAgentBSessionId,
    events,
    signal,
  } = options;

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

  // Skip stages below startFromStage when resuming.
  if (startFromStage !== undefined) {
    while (i < sorted.length && sorted[i].number < startFromStage) {
      i++;
    }
  }

  while (i < sorted.length) {
    // Check for cancellation before entering the next stage.
    if (signal?.aborted) {
      return {
        success: false,
        cancelled: true,
        stoppedAt: sorted[i].number,
        message: t()["pipeline.cancelled"],
      };
    }

    const stage = sorted[i];

    // In step mode, ask the user before entering each stage.
    if (mode === "step") {
      const ok = await prompt.confirmNextStage(stage.name);
      // Re-check for cancellation after the prompt resolves — the signal
      // may have been aborted while the user prompt was pending (Ctrl+C).
      if (signal?.aborted) {
        return {
          success: false,
          cancelled: true,
          stoppedAt: stage.number,
          message: t()["pipeline.cancelled"],
        };
      }
      if (!ok) {
        return {
          success: false,
          stoppedAt: stage.number,
          message: t()["pipeline.userSkipped"](stage.number, stage.name),
        };
      }
    }

    // On the first stage after resume, restore loop count and session IDs.
    const isResumeStage =
      startFromStage !== undefined && stage.number === startFromStage;

    const resumeLoopCount =
      isResumeStage &&
      startFromStageLoopCount !== undefined &&
      startFromStageLoopCount > 0
        ? startFromStageLoopCount
        : undefined;

    const result = await runStage(
      stage,
      context,
      prompt,
      onStageTransition,
      onSessionId,
      resumeLoopCount,
      isResumeStage ? savedAgentASessionId : undefined,
      isResumeStage ? savedAgentBSessionId : undefined,
      events,
      signal,
    );

    if (result.action === "abort") {
      return {
        success: false,
        stoppedAt: stage.number,
        message: result.message,
        cancelled: signal?.aborted === true ? true : undefined,
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
          message: t()["pipeline.invalidRestartTarget"](
            result.restartFromStage as number,
          ),
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
          result.message,
        );
        if (signal?.aborted) {
          return {
            success: false,
            cancelled: true,
            stoppedAt: stage.number,
            message: t()["pipeline.cancelled"],
          };
        }
        if (!approved) {
          return {
            success: false,
            stoppedAt: stage.number,
            message: t()["pipeline.userDeclinedRestartLoop"](lc.iteration),
          };
        }
        grantLoopBudget(lc);
      }

      i = targetIdx;
      // Persist the jump target so a crash before the next handler
      // invocation resumes at the correct stage.
      onStageTransition?.(sorted[targetIdx].number, 0);
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
    message: t()["pipeline.completed"],
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
    | "iteration"
    | "lastAutoIteration"
    | "userInstruction"
    | "onSessionId"
    | "savedAgentASessionId"
    | "savedAgentBSessionId"
    | "streamSinks"
    | "promptSinks"
  >,
  prompt: UserPrompt,
  onStageTransition?: (stageNumber: number, stageLoopCount: number) => void,
  onSessionId?: (agent: "a" | "b", sessionId: string) => void,
  resumeLoopCount?: number,
  savedAgentASessionId?: string,
  savedAgentBSessionId?: string,
  events?: PipelineEventEmitter,
  signal?: AbortSignal,
): Promise<StageRunResult> {
  const lc = createLoopControl(stage.autoBudget);

  // Restore loop state when resuming mid-stage.
  if (resumeLoopCount !== undefined) {
    lc.iteration = resumeLoopCount;
    lc.autoRemaining = Math.max(1, lc.budget - resumeLoopCount);
  }
  let userInstruction: string | undefined;
  /** Last not_approved message, forwarded to confirmContinueLoop. */
  let loopMessage = "";
  /** Tracks whether the last iteration was an auto-clarification retry. */
  let clarificationAttempted = false;

  // Build per-agent stream sinks that delegate to the event emitter.
  const streamSinks = events
    ? {
        a: (chunk: string) => events.emit("agent:chunk", { agent: "a", chunk }),
        b: (chunk: string) => events.emit("agent:chunk", { agent: "b", chunk }),
      }
    : undefined;

  // Build per-agent prompt sinks so the UI can display outgoing prompts
  // and track which agent is currently running.
  const promptSinks = events
    ? {
        a: (prompt: string) => {
          events.emit("agent:invoke", { agent: "a", type: "invoke" });
          events.emit("agent:prompt", { agent: "a", prompt });
        },
        b: (prompt: string) => {
          events.emit("agent:invoke", { agent: "b", type: "invoke" });
          events.emit("agent:prompt", { agent: "b", prompt });
        },
      }
    : undefined;

  // Build per-agent usage sinks so the UI can display token consumption.
  const usageSinks = events
    ? {
        a: (usage: import("./agent.js").TokenUsage) =>
          events.emit("agent:usage", { agent: "a", usage }),
        b: (usage: import("./agent.js").TokenUsage) =>
          events.emit("agent:usage", { agent: "b", usage }),
      }
    : undefined;

  while (true) {
    // Check for cancellation before each handler invocation.
    if (signal?.aborted) {
      return { action: "abort", message: t()["pipeline.cancelled"] };
    }

    // Notify caller before each handler invocation for persistence.
    onStageTransition?.(stage.number, lc.iteration);

    events?.emit("stage:enter", {
      stageNumber: stage.number,
      stageName: stage.name,
      iteration: lc.iteration,
    });

    const ctx: StageContext = {
      ...baseCtx,
      iteration: lc.iteration,
      lastAutoIteration: lc.autoRemaining === 1,
      userInstruction,
      onSessionId,
      savedAgentASessionId,
      savedAgentBSessionId,
      streamSinks,
      promptSinks,
      usageSinks,
      signal,
    };

    // Clear one-shot fields after use.
    userInstruction = undefined;
    savedAgentASessionId = undefined;
    savedAgentBSessionId = undefined;

    let result: StageResult;
    try {
      result = await stage.handler(ctx);
    } catch (err) {
      if (signal?.aborted) {
        return { action: "abort", message: t()["pipeline.cancelled"] };
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      const dispatched = await dispatchError(prompt, errMsg);
      if (dispatched === undefined) continue; // retry
      return dispatched;
    }

    events?.emit("stage:exit", {
      stageNumber: stage.number,
      outcome: result.outcome,
    });

    // Check for cancellation after handler returns.
    if (signal?.aborted) {
      return { action: "abort", message: t()["pipeline.cancelled"] };
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
      loopMessage = result.message;
      clarificationAttempted = false;
    } else if (result.outcome === "blocked") {
      clarificationAttempted = false;
      const decision = await prompt.handleBlocked(
        result.message,
        !stage.requiresArtifact,
      );
      if (signal?.aborted) {
        return { action: "abort", message: t()["pipeline.cancelled"] };
      }
      if (decision.action === "halt") {
        return { action: "abort", message: t()["pipeline.userHaltedBlocked"] };
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
        if (signal?.aborted) {
          return { action: "abort", message: t()["pipeline.cancelled"] };
        }
        if (decision.action === "halt") {
          return {
            action: "abort",
            message: t()["pipeline.userHaltedAmbiguous"],
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
    // Notify caller after loop counter change for persistence.
    onStageTransition?.(stage.number, lc.iteration);
    if (!canContinue) {
      const approved = await prompt.confirmContinueLoop(
        stage.name,
        lc.iteration,
        loopMessage,
      );
      loopMessage = "";
      if (signal?.aborted) {
        return { action: "abort", message: t()["pipeline.cancelled"] };
      }
      if (!approved) {
        return {
          action: "abort",
          message: t()["pipeline.userDeclinedLoop"](lc.iteration),
        };
      }
      grantLoopBudget(lc);
    }
  }
}

// ---- Stage 9: Done -------------------------------------------------------

/** Result of the `checkMergeable` callback. */
export type MergeableState = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/** Result of the `rebaseOntoMain` callback. */
export interface RebaseResult {
  /** Whether the rebase succeeded and was force-pushed. */
  success: boolean;
  /** Descriptive message (success note or error detail). */
  message: string;
}

/** Options for {@link createDoneStageHandler}. */
export interface DoneStageOptions {
  /** Pipeline event emitter for stage name overrides (e.g. "Rebase"). */
  events?: PipelineEventEmitter;
  /**
   * Check whether the PR has merge conflicts with the base branch.
   * Returns the resolved mergeable state (with retries for UNKNOWN).
   */
  checkMergeable: (ctx: StageContext) => Promise<MergeableState>;
  /** Prompt the user for conflict/unknown/merge choices. */
  prompt: {
    confirmMerge: (
      message: string,
    ) => Promise<"merged" | "check_conflicts" | "exit">;
    handleConflict: (message: string) => Promise<"agent_rebase" | "manual">;
    handleUnknownMergeable: (message: string) => Promise<"recheck" | "exit">;
    waitForManualResolve: (message: string) => Promise<void>;
  };
  /**
   * Invoke agent A to rebase onto origin/main, resolve conflicts,
   * verify locally (build + full test suite), and only force-push
   * when confident.  Limited to 1 attempt.
   */
  rebaseOntoMain: (ctx: StageContext) => Promise<RebaseResult>;
  /**
   * Poll CI and invoke the agent to fix failures after a rebase
   * or manual conflict resolution.  Re-uses the `pollCiAndFix`
   * pattern from the ci-check stage.
   */
  pollCiAndFix: (
    ctx: StageContext,
  ) => Promise<{ passed: boolean; message: string }>;
  /** Called to remove the worktree after merge is confirmed. */
  cleanup: () => void;
  /** Called to stop docker compose services. */
  stopServices: () => void;
  /** Called to check whether docker compose services are running. */
  hasRunningServices: () => boolean;
  /**
   * Called when the user chooses "not merged".  Presents cleanup options
   * (stop services, delete worktree, delete remote branch, close PR)
   * and performs the selected actions.  Receives the abort signal so it
   * can bail out early on cancellation.
   */
  onNotMerged: (signal?: AbortSignal) => Promise<void>;
}

/**
 * Built-in stage-9 handler.  Checks for merge conflicts, offers
 * agent rebase or manual resolution, then asks about merge.
 *
 * Callbacks are injected so the handler stays independent of the
 * worktree module and GitHub CLI, keeping the engine testable.
 */
export function createDoneStageHandler(
  options: DoneStageOptions,
): StageDefinition {
  // Agent rebase is limited to 1 attempt across all loop-backs.
  let rebaseAttempted = false;

  const doneName = t()["stage.done"];
  const rebaseName = t()["stage.rebase"];
  const emitStageName = (name: string) => {
    options.events?.emit("stage:name-override", { stageName: name });
  };

  return {
    name: t()["stage.done"],
    number: 9,
    handler: async (ctx) => {
      const m = t();
      const summary = m["pipeline.pipelineCompleted"](
        ctx.owner,
        ctx.repo,
        ctx.issueNumber,
      );

      // ---- Check mergeable state ------------------------------------------
      const mergeableLoop = async (): Promise<
        { done: true; result: StageResult } | { done: false }
      > => {
        const state = await options.checkMergeable(ctx);
        if (ctx.signal?.aborted) {
          return { done: true, result: { outcome: "completed", message: "" } };
        }

        if (state === "UNKNOWN") {
          const choice = await options.prompt.handleUnknownMergeable(
            m["pipeline.unknownMergeable"],
          );
          if (ctx.signal?.aborted) {
            return {
              done: true,
              result: { outcome: "completed", message: "" },
            };
          }
          if (choice === "recheck") {
            return { done: false }; // caller will loop
          }
          // "exit" — fall through to onNotMerged cleanup
          await options.onNotMerged(ctx.signal);
          return {
            done: true,
            result: { outcome: "completed", message: summary },
          };
        }

        if (state === "CONFLICTING") {
          const resolved = await handleConflicting(ctx, summary);
          if (resolved === undefined) {
            return { done: false }; // still conflicting after manual, re-check
          }
          return { done: true, result: resolved };
        }

        // MERGEABLE — proceed to merge confirmation.
        return { done: true, result: await askMerge(ctx, summary) };
      };

      // Allow the user to loop back via "re-check" or "still conflicting
      // after manual resolve".
      for (;;) {
        const outcome = await mergeableLoop();
        if (outcome.done) return outcome.result;
      }

      // ---- helper: CONFLICTING path --------------------------------------

      async function handleConflicting(
        ctx: StageContext,
        summary: string,
      ): Promise<StageResult | undefined> {
        const m = t();

        // When agent rebase was already attempted, skip straight to manual.
        if (rebaseAttempted) {
          await options.prompt.waitForManualResolve(
            m["prompt.pressAnyKeyWhenDone"],
          );
          if (ctx.signal?.aborted) {
            return { outcome: "completed", message: "" };
          }
          return afterResolution(ctx, summary);
        }

        const choice = await options.prompt.handleConflict(
          m["pipeline.conflictsDetected"],
        );
        if (ctx.signal?.aborted) {
          return { outcome: "completed", message: "" };
        }

        if (choice === "agent_rebase") {
          rebaseAttempted = true;
          emitStageName(rebaseName);
          const rebaseResult = await options.rebaseOntoMain(ctx);
          if (ctx.signal?.aborted) {
            emitStageName(doneName);
            return { outcome: "completed", message: "" };
          }
          if (!rebaseResult.success) {
            emitStageName(doneName);
            // Agent could not resolve — notify and fall back to manual.
            await options.prompt.waitForManualResolve(
              m["pipeline.rebaseFailed"],
            );
            if (ctx.signal?.aborted) {
              return { outcome: "completed", message: "" };
            }
            return afterResolution(ctx, summary);
          }
          // Agent rebase succeeded — re-check mergeable.
          return afterResolution(ctx, summary);
        }

        // Manual resolve.
        await options.prompt.waitForManualResolve(
          m["prompt.pressAnyKeyWhenDone"],
        );
        if (ctx.signal?.aborted) {
          return { outcome: "completed", message: "" };
        }
        return afterResolution(ctx, summary);
      }

      // ---- helper: after conflict resolution -------------------------------

      async function afterResolution(
        ctx: StageContext,
        summary: string,
      ): Promise<StageResult | undefined> {
        // Re-check mergeable after resolution.
        const state = await options.checkMergeable(ctx);
        if (ctx.signal?.aborted) {
          return { outcome: "completed", message: "" };
        }
        if (state === "CONFLICTING") {
          emitStageName(doneName);
          // Still conflicting — return undefined so the top-level loop
          // re-enters mergeableLoop → handleConflicting.
          return undefined;
        }
        if (state === "UNKNOWN") {
          emitStageName(doneName);
          // checkMergeable already exhausted its retry budget.  Show the
          // unknown-state prompt immediately instead of re-running the
          // full backoff cycle a second time.
          const choice = await options.prompt.handleUnknownMergeable(
            m["pipeline.unknownMergeable"],
          );
          if (ctx.signal?.aborted) {
            return { outcome: "completed", message: "" };
          }
          if (choice === "recheck") {
            return undefined; // re-enter outer loop (one fresh check)
          }
          // "exit"
          await options.onNotMerged(ctx.signal);
          return { outcome: "completed", message: summary };
        }

        // MERGEABLE — poll CI after resolution.
        const ciResult = await options.pollCiAndFix(ctx);
        emitStageName(doneName);
        console.error(
          `[done-stage-debug] afterResolution ciResult: passed=${ciResult.passed} message=${ciResult.message}`,
        );
        if (ctx.signal?.aborted) {
          return { outcome: "completed", message: "" };
        }
        if (!ciResult.passed) {
          // CI fix exhausted — notify user, still complete the stage.
          await options.onNotMerged(ctx.signal);
          return { outcome: "completed", message: ciResult.message };
        }

        // CI green — ask about merge.
        return askMerge(ctx, summary);
      }
    },
  };

  // ---- helper: MERGEABLE path (merge confirmation) -----------------------

  async function askMerge(
    ctx: StageContext,
    summary: string,
  ): Promise<StageResult> {
    const m = t();
    for (;;) {
      const choice = await options.prompt.confirmMerge(
        `${summary}\n\n${m["pipeline.mergeConfirm"]}`,
      );
      if (ctx.signal?.aborted) {
        return { outcome: "completed", message: "" };
      }

      if (choice === "merged") {
        options.stopServices();
        options.cleanup();
        return {
          outcome: "completed",
          message: `${summary} ${m["pipeline.worktreeCleanedUp"]}`,
        };
      }

      if (choice === "exit") {
        await options.onNotMerged(ctx.signal);
        return { outcome: "completed", message: summary };
      }

      // "check_conflicts" — inner loop lets UNKNOWN → "recheck" retry
      // checkMergeable without going through confirmMerge again.
      for (;;) {
        const state = await options.checkMergeable(ctx);
        if (ctx.signal?.aborted) {
          return { outcome: "completed", message: "" };
        }

        if (state === "MERGEABLE") {
          await options.prompt.waitForManualResolve(m["pipeline.noConflicts"]);
          if (ctx.signal?.aborted) {
            return { outcome: "completed", message: "" };
          }
          break; // back to confirmMerge
        }

        if (state === "UNKNOWN") {
          const unk = await options.prompt.handleUnknownMergeable(
            m["pipeline.unknownMergeable"],
          );
          if (ctx.signal?.aborted) {
            return { outcome: "completed", message: "" };
          }
          if (unk === "recheck") continue; // retry checkMergeable
          await options.onNotMerged(ctx.signal);
          return { outcome: "completed", message: summary };
        }

        // CONFLICTING — invoke agent rebase (one attempt only).
        if (rebaseAttempted) {
          await options.prompt.waitForManualResolve(
            m["pipeline.rebaseAlreadyAttempted"],
          );
          if (ctx.signal?.aborted) {
            return { outcome: "completed", message: "" };
          }
          break; // back to confirmMerge
        }
        rebaseAttempted = true;
        emitStageName(rebaseName);
        const rebaseResult = await options.rebaseOntoMain(ctx);
        if (ctx.signal?.aborted) {
          emitStageName(doneName);
          return { outcome: "completed", message: "" };
        }
        if (!rebaseResult.success) {
          emitStageName(doneName);
          break; // rebase failed — back to confirmMerge
        }

        // Rebase succeeded — poll CI and surface the result.
        const ciResult = await options.pollCiAndFix(ctx);
        emitStageName(doneName);
        if (ctx.signal?.aborted) {
          return { outcome: "completed", message: "" };
        }
        await options.prompt.waitForManualResolve(ciResult.message);
        if (ctx.signal?.aborted) {
          return { outcome: "completed", message: "" };
        }
        break; // back to confirmMerge
      }
    }
  }
}
