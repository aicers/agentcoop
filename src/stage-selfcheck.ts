/**
 * Stage 3 — Self-check loop.
 *
 * Two-step flow per iteration:
 *   1. Send a self-check prompt to Agent A covering 7 review items.
 *   2. Resume the session with a fix-or-done prompt.
 *
 * The agent responds with FIXED (loop again) or DONE (proceed).  The
 * pipeline engine's built-in loop control manages the 3-automatic /
 * 4th-asks-user budget — the handler returns `"not_approved"` on FIXED
 * so the engine loops.
 */

import type { AgentAdapter } from "./agent.js";
import { t } from "./i18n/index.js";
import {
  buildIssueSyncPrompt,
  type IssueChange,
  type IssueSyncStatus,
  parseIssueSyncResponse,
} from "./issue-sync.js";
import type { StageContext, StageDefinition, StageResult } from "./pipeline.js";
import {
  invokeOrResume,
  mapAgentError,
  mapFixOrDoneResponse,
  sendFollowUp,
} from "./stage-util.js";

export interface SelfCheckStageOptions {
  agent: AgentAdapter;
  issueTitle: string;
  issueBody: string;
  /**
   * Called when the issue description is updated or a comment is added
   * during issue sync.  The caller collects these for the final summary.
   */
  onIssueChange?: (change: IssueChange) => void;
  /**
   * Called with the overall outcome of the issue sync step so the
   * caller can distinguish "no discrepancies" from "sync skipped/failed".
   */
  onIssueSyncStatus?: (status: IssueSyncStatus) => void;
}

export function buildSelfCheckPrompt(
  ctx: StageContext,
  opts: SelfCheckStageOptions,
): string {
  const lines = [
    `You are reviewing the implementation for the following GitHub issue.`,
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
    `## Self-check`,
    ``,
    `Review the current implementation against all 7 items below.  For each`,
    `item, briefly note whether it passes or needs attention.`,
    ``,
    `1. **Correctness** — Does the implementation fully address the issue?`,
    `2. **Tests** — Are there sufficient tests?  Do all tests pass?`,
    `3. **Error handling** — Are errors handled gracefully?`,
    `4. **External services** — Are API calls, network requests, or external`,
    `   service integrations correct and resilient?`,
    `5. **Documentation consistency** — Are comments, READMEs, and inline`,
    `   docs consistent with the code changes?`,
    `6. **Security** — Are there any security concerns (injection, auth,`,
    `   secrets exposure)?`,
    `7. **Performance** — Are there obvious performance issues or regressions?`,
  ];

  if (ctx.userInstruction) {
    lines.push(``, `## Additional feedback`, ``, ctx.userInstruction);
  }

  return lines.join("\n");
}

export function buildFixOrDonePrompt(): string {
  return [
    `Based on your self-check above, decide what to do next.`,
    ``,
    `- If you found issues that need fixing, fix them now and end your`,
    `  response with the keyword FIXED.`,
    `- If everything looks good and no changes are needed, end your`,
    `  response with the keyword DONE.`,
  ].join("\n");
}

export function createSelfCheckStageHandler(
  opts: SelfCheckStageOptions,
): StageDefinition {
  return {
    name: t()["stage.selfCheck"],
    number: 3,
    handler: async (ctx: StageContext): Promise<StageResult> => {
      // Step 1: Send self-check prompt (resume if saved session).
      const checkPrompt = buildSelfCheckPrompt(ctx, opts);
      ctx.promptSinks?.a?.(checkPrompt);
      const checkResult = await invokeOrResume(
        opts.agent,
        ctx.savedAgentASessionId,
        checkPrompt,
        ctx.worktreePath,
        ctx.streamSinks?.a,
      );

      if (checkResult.sessionId) {
        ctx.onSessionId?.("a", checkResult.sessionId);
      }

      if (checkResult.status === "error") {
        return mapAgentError(checkResult, "during self-check");
      }

      // Step 2: Send fix-or-done prompt (resume the same session).
      const fixPrompt = buildFixOrDonePrompt();
      ctx.promptSinks?.a?.(fixPrompt);
      const fixResult = await sendFollowUp(
        opts.agent,
        checkResult.sessionId,
        fixPrompt,
        ctx.worktreePath,
        ctx.streamSinks?.a,
      );

      if (fixResult.status === "error") {
        return mapAgentError(fixResult, "during fix");
      }

      const result = mapFixOrDoneResponse(fixResult.responseText);

      // Step 3: Issue description sync (only when self-check is done).
      if (result.outcome === "completed" && fixResult.sessionId) {
        try {
          const syncPrompt = buildIssueSyncPrompt(ctx, opts);
          ctx.promptSinks?.a?.(syncPrompt);
          const syncResult = await sendFollowUp(
            opts.agent,
            fixResult.sessionId,
            syncPrompt,
            ctx.worktreePath,
            ctx.streamSinks?.a,
          );

          if (syncResult.status === "success") {
            const changes = parseIssueSyncResponse(syncResult.responseText);
            for (const change of changes) {
              opts.onIssueChange?.(change);
            }
            opts.onIssueSyncStatus?.("completed");
          } else {
            opts.onIssueSyncStatus?.("failed");
          }
        } catch {
          // Issue sync is best-effort; do not fail the stage.
          opts.onIssueSyncStatus?.("failed");
        }
      } else if (result.outcome === "completed") {
        // Self-check passed but we could not run issue sync (no session ID).
        opts.onIssueSyncStatus?.("skipped");
      }

      return result;
    },
  };
}
