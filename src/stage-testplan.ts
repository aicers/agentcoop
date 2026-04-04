/**
 * Stage 6 — Test plan verification loop.
 *
 * Two-step flow per iteration:
 *   1. Send a verification prompt to Agent A instructing it to verify
 *      PR test plan items and issue task checklist items.
 *   2. Resume the session with a self-check prompt.
 *
 * The agent responds with FIXED (loop again) or DONE (proceed).  The
 * pipeline engine's built-in loop control manages the 3-automatic /
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
} from "./stage-util.js";

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
    `   - Start all required infrastructure using Docker Compose.  If a`,
    `     port conflict occurs, change the port rather than skipping the`,
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
    `   off each completed task using \`gh\` commands.`,
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
    `- Are ALL task checklist items in the issue checked off?`,
    `- Is CI still passing?`,
    ``,
    `If you found and fixed issues during verification, end your`,
    `response with the keyword FIXED.`,
    ``,
    `If everything is verified and passing with no changes needed,`,
    `end your response with the keyword DONE.`,
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
      ctx.promptSinks?.a?.(verifyPrompt);
      const verifyResult = await invokeOrResume(
        opts.agent,
        ctx.savedAgentASessionId,
        verifyPrompt,
        ctx.worktreePath,
        ctx.streamSinks?.a,
        undefined,
        ctx.invokeHooks?.a,
      );

      if (verifyResult.sessionId) {
        ctx.onSessionId?.("a", verifyResult.sessionId);
      }

      if (verifyResult.status === "error") {
        return mapAgentError(verifyResult, "during test plan verification");
      }

      // Step 2: Send self-check prompt (resume the same session).
      const selfCheckPrompt = buildTestPlanSelfCheckPrompt();
      ctx.promptSinks?.a?.(selfCheckPrompt);
      const checkResult = await sendFollowUp(
        opts.agent,
        verifyResult.sessionId,
        selfCheckPrompt,
        ctx.worktreePath,
        ctx.streamSinks?.a,
        undefined,
        ctx.invokeHooks?.a,
      );

      if (checkResult.status === "error") {
        return mapAgentError(checkResult, "during test plan self-check");
      }

      return mapFixOrDoneResponse(checkResult.responseText);
    },
  };
}
