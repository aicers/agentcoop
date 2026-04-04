/**
 * Stage 7 — Review loop.
 *
 * Multi-agent flow per iteration:
 *   1. Agent B posts a review prefixed with `[Reviewer Round {n}]`,
 *      ending with APPROVED or NOT_APPROVED.
 *   2. If APPROVED — Agent B summarises unresolved items (or NONE),
 *      and the stage completes.
 *   3. If NOT_APPROVED:
 *      a. Agent A reads the review, fixes issues, and posts a response
 *         prefixed with `[Author Round {n}]`.
 *      b. Completion check on Agent A.
 *      c. Internal CI poll + fix loop.
 *      d. Returns `"not_approved"` so the pipeline engine loops for
 *         the next review round.
 *
 * The pipeline engine's auto-budget manages the 3-automatic /
 * 4th-asks-user contract.  `autoBudget` should be set from the
 * `reviewAutoRounds` config value in `index.ts`.
 */

import type { AgentAdapter, AgentResult } from "./agent.js";
import type { GetCiStatusFn } from "./ci.js";
import {
  collectFailureLogs as defaultCollectFailureLogs,
  getCiStatus as defaultGetCiStatus,
} from "./ci.js";
import { pollCiAndFix } from "./ci-poll.js";
import { t } from "./i18n/index.js";
import { buildPrSyncInstructions } from "./issue-sync.js";
import type { StageContext, StageDefinition, StageResult } from "./pipeline.js";
import {
  drainToSink,
  type InvokeHooks,
  invokeOrResume,
  mapAgentError,
  mapResponseToResult,
  type PromptSink,
  type StreamSink,
  sendFollowUp,
} from "./stage-util.js";
import { parseStepStatus } from "./step-parser.js";

// ---- public types ------------------------------------------------------------

export interface ReviewStageOptions {
  agentA: AgentAdapter;
  agentB: AgentAdapter;
  issueTitle: string;
  issueBody: string;
  /** Injected for testability. */
  getCiStatus?: GetCiStatusFn;
  /** Injected for testability. */
  collectFailureLogs?: (owner: string, repo: string, runId: number) => string;
  /** Injected for testability. Defaults to `worktree.getHeadSha`. */
  getHeadSha?: (cwd: string) => string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Grace period for empty SHA-filtered runs. Default 60 000. */
  emptyRunsGracePeriodMs?: number;
  maxFixAttempts?: number;
  /** Injected for testability. */
  delay?: (ms: number) => Promise<void>;
}

// ---- prompt builders ---------------------------------------------------------

export function buildReviewPrompt(
  ctx: StageContext,
  opts: ReviewStageOptions,
  round: number,
): string {
  const lines = [
    `You are reviewing a pull request for the following GitHub issue.`,
    ``,
    `## Repository`,
    `- Owner: ${ctx.owner}`,
    `- Repo: ${ctx.repo}`,
    `- Branch: ${ctx.branch}`,
    `- Worktree: ${ctx.worktreePath}`,
    ``,
    `## Issue #${ctx.issueNumber}: ${opts.issueTitle}`,
    ``,
    opts.issueBody,
    ``,
    `## Instructions`,
    ``,
    `1. Find the pull request for this branch (use \`gh pr view\`).`,
  ];

  if (round > 1) {
    lines.push(
      `2. Read the author's response in the PR comment prefixed with`,
      `   \`[Author Round ${round - 1}]\` to understand what was changed.`,
      `3. Review the updated code changes in the PR.  Evaluate`,
      `   correctness, test coverage, error handling, security, and`,
      `   performance.`,
      `4. Post your follow-up review as a PR comment prefixed with`,
      `   \`**[Reviewer Round ${round}]**\`.`,
      `5. End your response with one of these keywords:`,
    );
  } else {
    lines.push(
      `2. Review the code changes in the PR.  Evaluate correctness,`,
      `   test coverage, error handling, security, and performance.`,
      `3. Post your review as a PR comment prefixed with`,
      `   \`**[Reviewer Round ${round}]**\`.`,
      `4. End your response with one of these keywords:`,
    );
  }

  lines.push(
    `   - APPROVED — if the changes are ready to merge`,
    `   - NOT_APPROVED — if changes are needed`,
  );

  if (ctx.userInstruction) {
    lines.push(``, `## Additional feedback`, ``, ctx.userInstruction);
  }

  return lines.join("\n");
}

export function buildAuthorFixPrompt(
  ctx: StageContext,
  opts: ReviewStageOptions,
  round: number,
): string {
  const lines = [
    `You are addressing review feedback for the following GitHub issue.`,
    ``,
    `## Repository`,
    `- Owner: ${ctx.owner}`,
    `- Repo: ${ctx.repo}`,
    `- Branch: ${ctx.branch}`,
    `- Worktree: ${ctx.worktreePath}`,
    ``,
    `## Issue #${ctx.issueNumber}: ${opts.issueTitle}`,
    ``,
    opts.issueBody,
    ``,
    `## Instructions`,
    ``,
    `1. Find the pull request for this branch (use \`gh pr view\`).`,
    `2. Read the review comments prefixed with \`[Reviewer Round ${round}]\``,
    `   (only comments from your own account).`,
    `3. Fix all agreed-upon items from the review.`,
    `4. Post a response as a PR comment prefixed with`,
    `   \`**[Author Round ${round}]**\` summarising what you changed.`,
    `5. ${buildPrSyncInstructions(ctx.issueNumber)}`,
    `6. Commit and push your changes so a new CI run is triggered.`,
  ];

  return lines.join("\n");
}

export function buildAuthorCompletionCheckPrompt(): string {
  return [
    `You have finished addressing the review feedback.  Please evaluate`,
    `the result and respond with exactly one of the following keywords:`,
    ``,
    `- COMPLETED — if all feedback was addressed and changes were pushed`,
    `- BLOCKED — if you cannot proceed and need user intervention`,
  ].join("\n");
}

export function buildUnresolvedSummaryPrompt(round: number): string {
  return [
    `The review loop has ended.  Please check whether there are any`,
    `unresolved items from this review cycle.`,
    ``,
    `- If there are unresolved items, post a PR comment prefixed with`,
    `  \`**[Reviewer Unresolved Round ${round}]**\` listing each unresolved item.`,
    `  Then end your response with COMPLETED.`,
    `- If there are no unresolved items, respond with exactly: NONE`,
  ].join("\n");
}

// ---- handler -----------------------------------------------------------------

export function createReviewStageHandler(
  opts: ReviewStageOptions,
): StageDefinition {
  return {
    name: t()["stage.review"],
    number: 7,
    handler: async (ctx: StageContext): Promise<StageResult> => {
      const round = ctx.iteration + 1; // 1-based for display

      // Step 1: Agent B reviews (resume if saved session).
      const reviewPrompt = buildReviewPrompt(ctx, opts, round);
      ctx.promptSinks?.b?.(reviewPrompt);
      const reviewResult = await invokeOrResume(
        opts.agentB,
        ctx.savedAgentBSessionId,
        reviewPrompt,
        ctx.worktreePath,
        ctx.streamSinks?.b,
        undefined,
        ctx.invokeHooks?.b,
      );

      if (reviewResult.sessionId) {
        ctx.onSessionId?.("b", reviewResult.sessionId);
      }

      if (reviewResult.status === "error") {
        return mapAgentError(reviewResult, "during review");
      }

      // Parse review verdict.
      const reviewParsed = parseStepStatus(reviewResult.responseText);

      // Step 2: If approved — ask B for unresolved summary, then complete.
      if (reviewParsed.status === "approved") {
        const { error, summary } = await handleUnresolvedSummary(
          opts,
          reviewResult.sessionId,
          round,
          ctx.worktreePath,
          ctx.streamSinks?.b,
          ctx.promptSinks?.b,
          ctx.invokeHooks?.b,
        );
        if (error) return error;

        const m = t();
        const base = m["review.approved"](round);
        const message = summary
          ? m["review.unresolvedItems"](base, summary)
          : base;

        return { outcome: "completed", message };
      }

      // Treat anything other than not_approved as ambiguous → needs_clarification.
      if (reviewParsed.status !== "not_approved") {
        return mapResponseToResult(reviewResult.responseText);
      }

      // Step 3: NOT_APPROVED — Agent A fixes (resume if saved session).
      const fixPrompt = buildAuthorFixPrompt(ctx, opts, round);
      ctx.promptSinks?.a?.(fixPrompt);
      const fixResult = await invokeOrResume(
        opts.agentA,
        ctx.savedAgentASessionId,
        fixPrompt,
        ctx.worktreePath,
        ctx.streamSinks?.a,
        undefined,
        ctx.invokeHooks?.a,
      );

      if (fixResult.sessionId) {
        ctx.onSessionId?.("a", fixResult.sessionId);
      }

      if (fixResult.status === "error") {
        return mapAgentError(fixResult, "during author fix");
      }

      // Completion check on Agent A (with clarification retry,
      // same pattern as stage 4 / stage 8).
      const authorCheckPrompt = buildAuthorCompletionCheckPrompt();
      ctx.promptSinks?.a?.(authorCheckPrompt);
      let checkResult = await sendFollowUp(
        opts.agentA,
        fixResult.sessionId,
        authorCheckPrompt,
        ctx.worktreePath,
        ctx.streamSinks?.a,
        undefined,
        ctx.invokeHooks?.a,
      );

      if (checkResult.status === "error") {
        return mapAgentError(checkResult, "during author completion check");
      }

      let checkMapped = mapResponseToResult(checkResult.responseText);

      if (
        checkMapped.outcome === "needs_clarification" &&
        checkResult.sessionId
      ) {
        const retryPrompt = buildAuthorCompletionCheckPrompt();
        ctx.promptSinks?.a?.(retryPrompt);
        const retryResult = await sendFollowUp(
          opts.agentA,
          checkResult.sessionId,
          retryPrompt,
          ctx.worktreePath,
          ctx.streamSinks?.a,
          undefined,
          ctx.invokeHooks?.a,
        );

        if (retryResult.status === "error") {
          return mapAgentError(
            retryResult,
            "during author completion clarification",
          );
        }

        checkResult = retryResult;
        checkMapped = mapResponseToResult(retryResult.responseText);
      }

      if (checkMapped.outcome === "blocked") {
        return {
          outcome: "blocked",
          message: `${fixResult.responseText}\n\n---\n\n${checkResult.responseText}`,
        };
      }

      // If still ambiguous or unexpected, bubble up to the engine.
      if (
        checkMapped.outcome !== "completed" &&
        checkMapped.outcome !== "fixed" &&
        checkMapped.outcome !== "approved"
      ) {
        return checkMapped;
      }

      // Step 4: Poll CI after Agent A pushes.
      const ciResult = await pollCiAndFix({
        ctx,
        agent: opts.agentA,
        issueTitle: opts.issueTitle,
        issueBody: opts.issueBody,
        getCiStatus: opts.getCiStatus ?? defaultGetCiStatus,
        collectFailureLogs:
          opts.collectFailureLogs ?? defaultCollectFailureLogs,
        getHeadSha: opts.getHeadSha,
        emptyRunsGracePeriodMs: opts.emptyRunsGracePeriodMs,
        pollIntervalMs: opts.pollIntervalMs,
        pollTimeoutMs: opts.pollTimeoutMs,
        maxFixAttempts: opts.maxFixAttempts,
        delay: opts.delay,
      });

      if (!ciResult.passed) {
        return { outcome: "error", message: ciResult.message };
      }

      // CI passed — return not_approved so the engine loops for next round.
      let message = t()["review.fixesApplied"](round);

      if (ctx.lastAutoIteration) {
        const { error, summary } = await handleUnresolvedSummary(
          opts,
          reviewResult.sessionId,
          round,
          ctx.worktreePath,
          ctx.streamSinks?.b,
          ctx.promptSinks?.b,
          ctx.invokeHooks?.b,
        );
        if (error) return error;
        if (summary) {
          message = t()["review.unresolvedItems"](message, summary);
        }
      }

      return { outcome: "not_approved", message };
    },
  };
}

// ---- helpers -----------------------------------------------------------------

interface UnresolvedSummaryResult {
  /** Non-null when the agent returned an error. */
  error: StageResult | undefined;
  /** The summary text from Agent B, or `undefined` when NONE. */
  summary: string | undefined;
}

/**
 * Ask Agent B for an unresolved items summary.  Returns the summary
 * text so the caller can include it in the completion message shown
 * to the user.
 */
async function handleUnresolvedSummary(
  opts: ReviewStageOptions,
  sessionId: string | undefined,
  round: number,
  cwd: string,
  sink?: StreamSink,
  promptSink?: PromptSink,
  hooks?: InvokeHooks,
): Promise<UnresolvedSummaryResult> {
  const summaryPrompt = buildUnresolvedSummaryPrompt(round);
  promptSink?.(summaryPrompt);

  // If we have a session, resume; otherwise invoke fresh.
  let result: AgentResult;
  if (sessionId) {
    result = await sendFollowUp(
      opts.agentB,
      sessionId,
      summaryPrompt,
      cwd,
      sink,
      undefined,
      hooks,
    );
  } else {
    hooks?.onStart?.("invoke");
    try {
      const stream = opts.agentB.invoke(summaryPrompt, { cwd });
      if (sink) drainToSink(stream, sink);
      result = await stream.result;
    } finally {
      hooks?.onEnd?.();
    }
  }

  if (result.status === "error") {
    return {
      error: mapAgentError(result, "during unresolved summary"),
      summary: undefined,
    };
  }

  // Check whether Agent B said NONE.
  const upper = result.responseText.trim().toUpperCase();
  if (upper === "NONE" || upper.endsWith("NONE")) {
    return { error: undefined, summary: undefined };
  }

  return { error: undefined, summary: result.responseText };
}
