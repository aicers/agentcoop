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
  buildDocConsistencyInstructions,
  drainToSink,
  invokeOrResume,
  mapAgentError,
  mapResponseToResult,
  type PromptSink,
  type StreamSink,
  sendFollowUp,
  type UsageSink,
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

/**
 * Shared framing paragraph, review-angles bullet list, and closer.
 * Used by both Round 1 and Round 2+ review prompts so they cannot drift.
 */
function buildReviewAnglesBlock(): string {
  return [
    `   Your job is an`,
    `   independent judgment on whether this is the right change`,
    `   and whether it is built well — not a mechanical checklist.`,
    `   Read the code, form an opinion, and explain it with`,
    `   concrete references where they help anchor the point.`,
    ``,
    `   Common review angles include:`,
    `   - Whether the approach actually solves the issue, and`,
    `     whether any requirement appears to be dropped, only`,
    `     partially implemented, or implemented in a surprising way.`,
    `   - Correctness on edge cases and failure paths, not just the`,
    `     happy path.`,
    `   - Design quality: readability, appropriate abstractions,`,
    `     avoiding over-engineering, unrelated drive-by changes,`,
    `     dead code, or stray debug output.`,
    `   - Test presence and meaningfulness — especially whether the`,
    `     tests exercise the new behaviour in a way that would have`,
    `     failed before the change. You do NOT need to run the test`,
    `     suite or re-check CI; assume those are already handled and`,
    `     focus on whether the tests are the right tests.`,
    `   - Error handling, security (input validation, injection,`,
    `     secrets, permissions), and obvious performance issues.`,
    `   - Documentation or comments that now appear out of sync with`,
    `     the code.`,
    `   - PR hygiene if it appears off: issue linkage (\`Closes #N\``,
    `     vs. \`Part of #N\` with \`## Not addressed\` when partial) and`,
    `     a \`## Test plan\` checklist.`,
    ``,
    `   The list above is guidance, not a limit. If something feels`,
    `   off for any other reason — architectural, stylistic, product,`,
    `   or subtle — raise it.`,
  ].join("\n");
}

export function buildReviewPrompt(
  ctx: StageContext,
  opts: ReviewStageOptions,
  round: number,
): string {
  const anglesBlock = buildReviewAnglesBlock();

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
      `   For each item you raised in \`[Reviewer Round ${round - 1}]\`,`,
      `   check the outcome:`,
      `   - If the author says it was fixed, verify that the fix is`,
      `     actually present in the updated diff.`,
      `   - If the author pushed back with reasoning, evaluate that`,
      `     reasoning honestly. If it is sound, treat the item as`,
      `     resolved and do NOT re-raise it. If it is weak, unclear,`,
      `     or does not address the concern, keep the item open.`,
      `   - Only carry forward items that remain genuinely unresolved.`,
      `3. Review the updated diff against the issue.`,
      anglesBlock,
      `4. Post your follow-up review as a PR comment prefixed with`,
      `   \`**[Reviewer Round ${round}]**\`. Include any still-unresolved`,
      `   prior items and any new findings from this round. Be`,
      `   specific. Cite file paths and line numbers when they help;`,
      `   for broader concerns, explain the concern at the`,
      `   appropriate level.`,
      `5. End your response with one of these keywords:`,
    );
  } else {
    lines.push(
      `2. Review the diff against the issue.`,
      anglesBlock,
      `3. Post your review as a PR comment prefixed with`,
      `   \`**[Reviewer Round ${round}]**\`. Be specific. Cite file paths and`,
      `   line numbers when they help; for broader concerns, explain`,
      `   the concern at the appropriate level.`,
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
    `5. ${buildDocConsistencyInstructions("   ").trimStart()}`,
    `6. ${buildPrSyncInstructions(ctx.issueNumber)}`,
    `7. Commit and push your changes so a new CI run is triggered.`,
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

export function buildPrFinalizationPrompt(
  ctx: StageContext,
  opts: ReviewStageOptions,
): string {
  return [
    `The review is complete and the PR has been approved.  Before`,
    `merging, verify that the PR body accurately reflects the final`,
    `state of the implementation.`,
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
    `1. Read the current PR body using`,
    `   \`gh pr view --json body --jq .body\`.`,
    `2. Compare the issue requirements above against the code on the`,
    `   branch to determine whether every requirement has been addressed.`,
    `3. If the PR fully resolves the issue, ensure the body contains`,
    `   "Closes #${ctx.issueNumber}".  If it only partially addresses it,`,
    `   ensure it says "Part of #${ctx.issueNumber}" and includes a`,
    `   "## Not addressed" section listing which issue requirements`,
    `   were not implemented and why.`,
    `4. If the reference or "## Not addressed" section needs to change,`,
    `   update the PR body using \`gh pr edit --body "..."\`.`,
    `5. End your response with PR_FINALIZED.`,
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
        ctx.usageSinks?.b,
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
          ctx.usageSinks?.b,
        );
        if (error) return error;

        // PR finalization: Agent A verifies issue reference and
        // "Not addressed" section before the pipeline advances.
        const finalizePrompt = buildPrFinalizationPrompt(ctx, opts);
        ctx.promptSinks?.a?.(finalizePrompt);
        const finalizeResult = await invokeOrResume(
          opts.agentA,
          ctx.savedAgentASessionId,
          finalizePrompt,
          ctx.worktreePath,
          ctx.streamSinks?.a,
          undefined,
          ctx.usageSinks?.a,
        );

        if (finalizeResult.sessionId) {
          ctx.onSessionId?.("a", finalizeResult.sessionId);
        }

        if (finalizeResult.status === "error") {
          return mapAgentError(finalizeResult, "during PR finalization");
        }

        if (!finalizeResult.responseText.includes("PR_FINALIZED")) {
          return {
            outcome: "needs_clarification",
            message: finalizeResult.responseText,
          };
        }

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
        ctx.usageSinks?.a,
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
        ctx.usageSinks?.a,
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
          ctx.usageSinks?.a,
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
          ctx.usageSinks?.b,
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
  usageSink?: UsageSink,
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
      usageSink,
    );
  } else {
    const stream = opts.agentB.invoke(summaryPrompt, {
      cwd,
      onUsage: usageSink,
    });
    if (sink) drainToSink(stream, sink);
    result = await stream.result;
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
