/**
 * Stage 7 — Review loop.
 *
 * Multi-agent flow per iteration:
 *   1. Agent B posts a review prefixed with `[Reviewer Round {n}]`.
 *   2. A dedicated verdict follow-up asks Agent B for exactly
 *      APPROVED or NOT_APPROVED — the review text is **not** parsed
 *      for keywords.
 *   3. If APPROVED — Agent B summarises unresolved items (or NONE),
 *      Agent A performs PR finalization (verdict: PR_FINALIZED), and
 *      the stage completes.
 *   4. If NOT_APPROVED:
 *      a. Agent A reads the review, fixes issues, and posts a response
 *         prefixed with `[Author Round {n}]`.
 *      b. Completion check on Agent A (verdict: COMPLETED / BLOCKED).
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
import { getPrBody as defaultGetPrBody } from "./pr.js";
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
import {
  buildClarificationPrompt,
  parseStepStatus,
  parseVerdictKeyword,
} from "./step-parser.js";

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
  /** Injected for testability. Defaults to `pr.getPrBody`. */
  getPrBody?: (
    owner: string,
    repo: string,
    branch: string,
  ) => string | undefined;
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
    );
  } else {
    lines.push(
      `2. Review the diff against the issue.`,
      anglesBlock,
      `3. Post your review as a PR comment prefixed with`,
      `   \`**[Reviewer Round ${round}]**\`. Be specific. Cite file paths and`,
      `   line numbers when they help; for broader concerns, explain`,
      `   the concern at the appropriate level.`,
    );
  }

  if (ctx.userInstruction) {
    lines.push(``, `## Additional feedback`, ``, ctx.userInstruction);
  }

  return lines.join("\n");
}

export const REVIEW_VERDICT_KEYWORDS = ["APPROVED", "NOT_APPROVED"] as const;

export function buildReviewVerdictPrompt(): string {
  return [
    `You have posted your review comment.`,
    `Respond with exactly one of the following keywords:`,
    ``,
    `- APPROVED — if the changes are ready to merge`,
    `- NOT_APPROVED — if changes are needed`,
    ``,
    `Do not include any other commentary — just the keyword.`,
  ].join("\n");
}

export const AUTHOR_CHECK_KEYWORDS = ["COMPLETED", "BLOCKED"] as const;

export const UNRESOLVED_KEYWORDS = ["NONE", "COMPLETED"] as const;

export function buildUnresolvedVerdictPrompt(): string {
  return [
    `Respond with exactly one of the following keywords:`,
    ``,
    `- NONE — if there are no unresolved items`,
    `- COMPLETED — if you posted the unresolved items comment`,
    ``,
    `Do not include any other commentary — just the keyword.`,
  ].join("\n");
}

export const PR_FINALIZATION_KEYWORDS = ["PR_FINALIZED"] as const;

export function buildPrFinalizationVerdictPrompt(): string {
  return [
    `You have finished verifying the PR body.`,
    `Respond with exactly one of the following keywords:`,
    ``,
    `- PR_FINALIZED — if the PR body is now accurate`,
    ``,
    `Do not include any other commentary — just the keyword.`,
  ].join("\n");
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
    ``,
    `Do not include any other commentary — just the keyword.`,
  ].join("\n");
}

export function buildUnresolvedSummaryPrompt(round: number): string {
  return [
    `The review loop has ended.  Please check whether there are any`,
    `unresolved items from this review cycle.`,
    ``,
    `- If there are unresolved items, post a PR comment prefixed with`,
    `  \`**[Reviewer Unresolved Round ${round}]**\` listing each unresolved item.`,
    `- If there are no unresolved items, simply confirm that there is`,
    `  nothing left to address.`,
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
  ].join("\n");
}

/**
 * Check whether the response is exactly the PR_FINALIZED keyword.
 * Uses the strict verdict parser to reject extra commentary.
 */
function hasFinalizationKeyword(text: string): boolean {
  return (
    parseVerdictKeyword(text, PR_FINALIZATION_KEYWORDS).keyword !== undefined
  );
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

      // Verdict follow-up: ask B for exactly APPROVED / NOT_APPROVED.
      const verdictPrompt = buildReviewVerdictPrompt();
      ctx.promptSinks?.b?.(verdictPrompt);
      let verdictResult = await sendFollowUp(
        opts.agentB,
        reviewResult.sessionId,
        verdictPrompt,
        ctx.worktreePath,
        ctx.streamSinks?.b,
        undefined,
        ctx.usageSinks?.b,
      );

      if (verdictResult.status === "error") {
        return mapAgentError(verdictResult, "during review verdict");
      }

      let reviewVerdict = parseVerdictKeyword(
        verdictResult.responseText,
        REVIEW_VERDICT_KEYWORDS,
      );

      // Clarification retry if ambiguous, extra commentary, or
      // multiple valid keywords.
      if (reviewVerdict.keyword === undefined) {
        const clarifyPrompt = buildClarificationPrompt(
          verdictResult.responseText,
          REVIEW_VERDICT_KEYWORDS,
        );
        ctx.promptSinks?.b?.(clarifyPrompt);
        const retryResult = await sendFollowUp(
          opts.agentB,
          verdictResult.sessionId ?? reviewResult.sessionId,
          clarifyPrompt,
          ctx.worktreePath,
          ctx.streamSinks?.b,
          undefined,
          ctx.usageSinks?.b,
        );

        if (retryResult.status === "error") {
          return mapAgentError(
            retryResult,
            "during review verdict clarification",
          );
        }

        verdictResult = retryResult;
        reviewVerdict = parseVerdictKeyword(
          verdictResult.responseText,
          REVIEW_VERDICT_KEYWORDS,
        );
      }

      // Step 2: If approved — ask B for unresolved summary, then complete.
      const reviewParsed = reviewVerdict.keyword
        ? parseStepStatus(reviewVerdict.keyword)
        : { status: "ambiguous" as const, keyword: undefined };
      if (reviewParsed.status === "approved") {
        const { error, summary } = await handleUnresolvedSummary(
          opts,
          verdictResult.sessionId ?? reviewResult.sessionId,
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

        // Verdict follow-up: ask A for exactly PR_FINALIZED.
        const finalVerdictPrompt = buildPrFinalizationVerdictPrompt();
        ctx.promptSinks?.a?.(finalVerdictPrompt);
        let finalVerdictResult = await sendFollowUp(
          opts.agentA,
          finalizeResult.sessionId,
          finalVerdictPrompt,
          ctx.worktreePath,
          ctx.streamSinks?.a,
          undefined,
          ctx.usageSinks?.a,
        );

        if (finalVerdictResult.status === "error") {
          return mapAgentError(
            finalVerdictResult,
            "during PR finalization verdict",
          );
        }

        if (!hasFinalizationKeyword(finalVerdictResult.responseText)) {
          // Clarification retry.
          const clarifyPrompt = buildClarificationPrompt(
            finalVerdictResult.responseText,
            PR_FINALIZATION_KEYWORDS,
          );
          ctx.promptSinks?.a?.(clarifyPrompt);
          const retryResult = await sendFollowUp(
            opts.agentA,
            finalVerdictResult.sessionId ?? finalizeResult.sessionId,
            clarifyPrompt,
            ctx.worktreePath,
            ctx.streamSinks?.a,
            undefined,
            ctx.usageSinks?.a,
          );

          if (retryResult.status === "error") {
            return mapAgentError(
              retryResult,
              "during PR finalization clarification",
            );
          }

          finalVerdictResult = retryResult;
        }

        // If the keyword is still missing after the in-session retry,
        // verify the PR body directly.  The squash stage short-circuits
        // on single-commit branches, so we cannot rely on a later stage
        // to catch a missing issue reference.
        //
        // The finalization contract requires an accurate PR body: the
        // correct issue reference (Closes vs Part of) AND, when partial,
        // a "## Not addressed" section.  A bare issue reference is not
        // sufficient — we verify that "Closes" and "Part of" each pair
        // with the expected companion state:
        //   - Closes #N  → no "## Not addressed" (contradictory otherwise)
        //   - Part of #N → "## Not addressed" must be present
        if (!hasFinalizationKeyword(finalVerdictResult.responseText)) {
          const getPrBody = opts.getPrBody ?? defaultGetPrBody;
          const body = getPrBody(ctx.owner, ctx.repo, ctx.branch);

          const closesRef =
            body !== undefined &&
            new RegExp(`Closes\\s+#${ctx.issueNumber}\\b`, "i").test(body);
          const partOfRef =
            body !== undefined &&
            new RegExp(`Part of\\s+#${ctx.issueNumber}\\b`, "i").test(body);
          const hasNotAddressed =
            body !== undefined && /^## Not addressed/im.test(body);

          // The body must contain exactly one reference form.  Both
          // present is self-contradictory (closes implies full fix,
          // "Part of" implies partial).  Then validate the companion:
          //   - Closes #N  → no "## Not addressed" section
          //   - Part of #N → "## Not addressed" must be present
          const exclusiveRef = closesRef !== partOfRef;
          const bodyValid =
            exclusiveRef &&
            ((closesRef && !hasNotAddressed) || (partOfRef && hasNotAddressed));

          if (!bodyValid) {
            return {
              outcome: "blocked",
              message: t()["review.finalizationUnverified"](ctx.issueNumber),
            };
          }
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
        return {
          outcome: "needs_clarification",
          message: verdictResult.responseText,
          validVerdicts: REVIEW_VERDICT_KEYWORDS,
        };
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

      let checkMapped = mapResponseToResult(
        checkResult.responseText,
        undefined,
        AUTHOR_CHECK_KEYWORDS,
      );

      if (checkMapped.outcome === "needs_clarification") {
        const retryPrompt = buildClarificationPrompt(
          checkResult.responseText,
          AUTHOR_CHECK_KEYWORDS,
        );
        ctx.promptSinks?.a?.(retryPrompt);
        const retryResult = await sendFollowUp(
          opts.agentA,
          checkResult.sessionId ?? fixResult.sessionId,
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
        checkMapped = mapResponseToResult(
          checkResult.responseText,
          undefined,
          AUTHOR_CHECK_KEYWORDS,
        );
      }

      if (
        checkMapped.outcome === "blocked" ||
        checkMapped.outcome === "needs_clarification"
      ) {
        // Surface a blocked condition so the user can decide how to
        // proceed.  Treating an ambiguous author-completion verdict as
        // progress would poll stale CI on an unchanged head when the
        // agent actually meant BLOCKED.
        return {
          outcome: "blocked",
          message: `${fixResult.responseText}\n\n---\n\n${checkResult.responseText}`,
        };
      }

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
          verdictResult.sessionId ?? reviewResult.sessionId,
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

  const summaryText = result.responseText;

  // Verdict follow-up: ask for exactly NONE or COMPLETED.
  const verdictPrompt = buildUnresolvedVerdictPrompt();
  promptSink?.(verdictPrompt);
  let verdictResult: AgentResult;
  const verdictSessionId = result.sessionId ?? sessionId;

  if (verdictSessionId) {
    verdictResult = await sendFollowUp(
      opts.agentB,
      verdictSessionId,
      verdictPrompt,
      cwd,
      sink,
      undefined,
      usageSink,
    );
  } else {
    const stream = opts.agentB.invoke(verdictPrompt, {
      cwd,
      onUsage: usageSink,
    });
    if (sink) drainToSink(stream, sink);
    verdictResult = await stream.result;
  }

  if (verdictResult.status === "error") {
    return {
      error: mapAgentError(verdictResult, "during unresolved summary verdict"),
      summary: undefined,
    };
  }

  // Check whether Agent B said NONE or COMPLETED using the strict parser.
  let verdict = parseVerdictKeyword(
    verdictResult.responseText,
    UNRESOLVED_KEYWORDS,
  );

  // Clarification retry if the verdict is ambiguous or out-of-scope.
  if (verdict.keyword === undefined) {
    const clarifyPrompt = buildClarificationPrompt(
      verdictResult.responseText,
      UNRESOLVED_KEYWORDS,
    );
    promptSink?.(clarifyPrompt);

    const verdictSessionId2 = verdictResult.sessionId ?? sessionId;
    let retryResult: AgentResult;

    if (verdictSessionId2) {
      retryResult = await sendFollowUp(
        opts.agentB,
        verdictSessionId2,
        clarifyPrompt,
        cwd,
        sink,
        undefined,
        usageSink,
      );
    } else {
      const stream = opts.agentB.invoke(clarifyPrompt, {
        cwd,
        onUsage: usageSink,
      });
      if (sink) drainToSink(stream, sink);
      retryResult = await stream.result;
    }

    if (retryResult.status === "error") {
      return {
        error: mapAgentError(
          retryResult,
          "during unresolved summary clarification",
        ),
        summary: undefined,
      };
    }

    verdict = parseVerdictKeyword(
      retryResult.responseText,
      UNRESOLVED_KEYWORDS,
    );
  }

  if (verdict.keyword?.toUpperCase() === "NONE") {
    return { error: undefined, summary: undefined };
  }

  if (verdict.keyword?.toUpperCase() === "COMPLETED") {
    return { error: undefined, summary: summaryText };
  }

  // Still ambiguous after retry — conservatively include the summary
  // text rather than bubbling to the pipeline engine.  The engine
  // would inject A-side clarification into Agent B's review prompt,
  // which cannot resolve an Agent-B unresolved-summary verdict.
  // Including the summary is the safe default: it surfaces unresolved
  // items to the user instead of silently dropping them.
  return { error: undefined, summary: summaryText };
}
