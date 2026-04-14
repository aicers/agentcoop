/**
 * Stage 6 — Test plan verification loop.
 *
 * Three-step flow per iteration:
 *   1. Send a verification prompt to Agent A instructing it to verify
 *      PR test plan items and issue task checklist items.
 *   2. Resume the session with a self-check work prompt — the agent
 *      performs fixes if needed but does **not** embed a verdict keyword.
 *   3. A dedicated verdict follow-up asks for exactly FIXED or DONE.
 *
 * The pipeline engine's built-in loop control manages the 3-automatic /
 * 4th-asks-user budget — the handler returns `"not_approved"` on FIXED
 * so the engine loops.
 */

import type { AgentAdapter } from "./agent.js";
import { t } from "./i18n/index.js";
import { buildPrSyncInstructions } from "./issue-sync.js";
import type { StageContext, StageDefinition, StageResult } from "./pipeline.js";
import {
  invokeOrResume,
  mapAgentError,
  mapFixOrDoneResponse,
  sendFollowUp,
  type VerdictContext,
} from "./stage-util.js";
import { buildClarificationPrompt } from "./step-parser.js";

export interface TestPlanStageOptions {
  agent: AgentAdapter;
  issueTitle: string;
  issueBody: string;
}

export function buildTestPlanVerifyPrompt(
  ctx: StageContext,
  opts: TestPlanStageOptions,
): string {
  const lines = [
    `You are verifying the test plan for the following GitHub issue.`,
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
    `2. Go through each item in the PR's "Test plan" checklist.  For`,
    `   each item, actually run or verify the described test or behavior.`,
    `   - Start all required services (dev servers, databases, external`,
    `     services, etc.) using whatever tools the project provides`,
    `     (Docker Compose, \`pnpm dev\`, setup scripts, etc.).  If a port`,
    `     conflict occurs, change the port rather than skipping the`,
    `     service.`,
    `   - If a browser is needed for testing, launch one (e.g., headless`,
    `     Chrome via Playwright).`,
    `   - For manual test items, do not defer them to the user.  Act as`,
    `     the end user: launch the application, navigate the UI, verify`,
    `     behavior, and check off each item yourself.  Use browser`,
    `     automation (Playwright, headless Chrome) or direct CLI/API`,
    `     interaction to replicate what a human user would do.`,
    `   - Only flag a test item for the user if it is truly impossible`,
    `     to verify programmatically (e.g., subjective visual design`,
    `     judgment).`,
    `   - When documentation or the PR requires screenshots, do not use`,
    `     placeholders.  Actually start the application, open a browser,`,
    `     and capture real screenshots.`,
    `3. Check off each verified item in the PR using \`gh\` commands.`,
    `4. Also go through the task checklist in the GitHub issue.  Check`,
    `   off each completed task using \`gh\` commands.  Then check the`,
    `   issue's parent issue (and grandparent, recursively) and check`,
    `   off any tasks that are now completed.`,
    `5. If you made any code changes:`,
    `   ${buildPrSyncInstructions(ctx.issueNumber)}`,
    `   Then commit and push them so a new CI run is triggered.`,
    `6. Make sure CI is still passing after any changes.`,
  ];

  if (ctx.userInstruction) {
    lines.push(``, `## Additional feedback`, ``, ctx.userInstruction);
  }

  return lines.join("\n");
}

export function buildTestPlanSelfCheckPrompt(): string {
  return [
    `Based on your verification above, evaluate the current state.`,
    ``,
    `- Are ALL test plan items in the PR checked off?`,
    `- Are ALL task checklist items in the issue checked off?  Also check`,
    `  off completed tasks in the issue's parent issue (and grandparent,`,
    `  recursively) when applicable.`,
    `- Is CI still passing?`,
    ``,
    `If you found issues during verification, fix them now.`,
    `If everything is verified and passing, you are done.`,
  ].join("\n");
}

export const TEST_PLAN_VERDICT_KEYWORDS = ["FIXED", "DONE"] as const;

export function buildTestPlanVerdictPrompt(): string {
  return [
    `You have finished the test plan verification pass.`,
    `Respond with exactly one of the following keywords:`,
    ``,
    `- FIXED — if you found and fixed issues`,
    `- DONE — if everything is verified and passing with no changes needed`,
    ``,
    `Do not include any other commentary — just the keyword.`,
  ].join("\n");
}

export function createTestPlanStageHandler(
  opts: TestPlanStageOptions,
): StageDefinition {
  return {
    name: t()["stage.testPlan"],
    number: 6,
    handler: async (ctx: StageContext): Promise<StageResult> => {
      // Step 1: Send verification prompt (resume if saved session).
      const verifyPrompt = buildTestPlanVerifyPrompt(ctx, opts);
      ctx.promptSinks?.a?.(verifyPrompt, "work");
      const verifyResult = await invokeOrResume(
        opts.agent,
        ctx.savedAgentASessionId,
        verifyPrompt,
        ctx.worktreePath,
        ctx.streamSinks?.a,
        undefined,
        ctx.usageSinks?.a,
      );

      if (verifyResult.sessionId) {
        ctx.onSessionId?.("a", verifyResult.sessionId);
      }

      if (verifyResult.status === "error") {
        return mapAgentError(verifyResult, "during test plan verification");
      }

      // Step 2: Send self-check work prompt (resume the same session).
      const selfCheckPrompt = buildTestPlanSelfCheckPrompt();
      ctx.promptSinks?.a?.(selfCheckPrompt, "work");
      const checkResult = await sendFollowUp(
        opts.agent,
        verifyResult.sessionId,
        selfCheckPrompt,
        ctx.worktreePath,
        ctx.streamSinks?.a,
        undefined,
        ctx.usageSinks?.a,
      );

      if (checkResult.status === "error") {
        return mapAgentError(checkResult, "during test plan self-check");
      }

      // Step 3: Verdict follow-up — ask for exactly FIXED or DONE.
      const verdictPrompt = buildTestPlanVerdictPrompt();
      ctx.promptSinks?.a?.(verdictPrompt, "verdict-followup");
      const verdictResult = await sendFollowUp(
        opts.agent,
        checkResult.sessionId,
        verdictPrompt,
        ctx.worktreePath,
        ctx.streamSinks?.a,
        undefined,
        ctx.usageSinks?.a,
      );

      if (verdictResult.status === "error") {
        return mapAgentError(verdictResult, "during test plan verdict");
      }

      const verdictCtx: VerdictContext | undefined = ctx.events
        ? { events: ctx.events, agent: "a" }
        : undefined;

      let result = mapFixOrDoneResponse(
        verdictResult.responseText,
        TEST_PLAN_VERDICT_KEYWORDS,
        verdictCtx,
      );

      // Internal clarification retry (same pattern as other stages).
      if (result.outcome === "needs_clarification") {
        const clarifyPrompt = buildClarificationPrompt(
          verdictResult.responseText,
          TEST_PLAN_VERDICT_KEYWORDS,
        );
        ctx.promptSinks?.a?.(clarifyPrompt, "verdict-followup");
        const retryResult = await sendFollowUp(
          opts.agent,
          verdictResult.sessionId ?? checkResult.sessionId,
          clarifyPrompt,
          ctx.worktreePath,
          ctx.streamSinks?.a,
          undefined,
          ctx.usageSinks?.a,
        );

        if (retryResult.status === "error") {
          return mapAgentError(
            retryResult,
            "during test plan verdict clarification",
          );
        }

        result = mapFixOrDoneResponse(
          retryResult.responseText,
          TEST_PLAN_VERDICT_KEYWORDS,
          verdictCtx,
        );
      }

      // If still ambiguous after the in-session retry, fall back to
      // not_approved so the pipeline loops (or restarts from an
      // earlier stage).  Treating ambiguity as "completed" would
      // advance past a verdict that may have been FIXED.
      if (result.outcome === "needs_clarification") {
        result = { outcome: "not_approved", message: result.message };
      }

      return result;
    },
  };
}
