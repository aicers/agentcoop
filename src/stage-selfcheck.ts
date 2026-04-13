/**
 * Stage 3 — Self-check loop.
 *
 * Three-step flow per iteration:
 *   1. Send a self-check prompt to Agent A covering 8 review items.
 *   2. Resume the session with a fix-or-done work prompt — the agent
 *      performs fixes if needed but does **not** embed a verdict keyword.
 *   3. A dedicated verdict follow-up asks for exactly FIXED or DONE.
 *
 * The pipeline engine's built-in loop control manages the 3-automatic /
 * 4th-asks-user budget — the handler returns `"not_approved"` on FIXED
 * so the engine loops.
 */

import type { AgentAdapter } from "./agent.js";
import { t } from "./i18n/index.js";
import {
  buildIssueSyncClarificationPrompt,
  buildIssueSyncPrompt,
  buildIssueSyncVerdictPrompt,
  type IssueChange,
  type IssueSyncStatus,
  parseIssueSyncResponse,
} from "./issue-sync.js";
import type { StageContext, StageDefinition, StageResult } from "./pipeline.js";
import {
  buildDocConsistencyInstructions,
  invokeOrResume,
  mapAgentError,
  mapFixOrDoneResponse,
  sendFollowUp,
} from "./stage-util.js";
import { buildClarificationPrompt } from "./step-parser.js";

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
    `Review the current implementation against all 8 items below.  For each`,
    `item, briefly note whether it passes or needs attention.`,
    ``,
    `1. **Correctness** — Does the implementation fully address the issue?`,
    `2. **Tests** — Are there thorough tests covering happy paths,`,
    `   edge cases, and error scenarios, including E2E tests where`,
    `   applicable?  If any meaningful scenario is untested, write`,
    `   the missing tests.  Then run the full test suite and verify all tests pass.`,
    `   If tests require services (databases, message brokers, dev`,
    `   servers, etc.), start them using whatever tools the project`,
    `   provides (Docker Compose, \`pnpm dev\`, setup scripts, etc.).`,
    `   If a port conflict occurs, change the port rather than skipping`,
    `   the service.`,
    `3. **Error handling** — Are errors handled gracefully?`,
    `4. **External services** — Are API calls, network requests, or external`,
    `   service integrations correct and resilient?  Start all required`,
    `   services and run integration tests against them rather than skipping`,
    `   tests that need external services.`,
    `5. **Documentation consistency** — Are all forms of project`,
    `   documentation consistent with the code changes?`,
    ``,
    buildDocConsistencyInstructions("   "),
    `6. **Security** — Are there any security concerns (injection, auth,`,
    `   secrets exposure)?`,
    `7. **Performance** — Are there obvious performance issues or regressions?`,
    `8. **Code quality** — Is the new or modified code clean and`,
    `   maintainable?  If you spot opportunities to simplify, improve,`,
    `   or refactor the code *within the scope of this change*, apply`,
    `   them.  Do not refactor unrelated existing code.`,
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
    `- If you found issues that need fixing, fix them now.`,
    `- If everything looks good and no changes are needed, you are done.`,
  ].join("\n");
}

export const FIX_OR_DONE_KEYWORDS = ["FIXED", "DONE"] as const;

export function buildFixOrDoneVerdictPrompt(): string {
  return [
    `You have finished the self-check pass.`,
    `Respond with exactly one of the following keywords:`,
    ``,
    `- FIXED — if you found and fixed issues`,
    `- DONE — if everything looks good and no changes were needed`,
    ``,
    `Do not include any other commentary — just the keyword.`,
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
        undefined,
        ctx.usageSinks?.a,
      );

      if (checkResult.sessionId) {
        ctx.onSessionId?.("a", checkResult.sessionId);
      }

      if (checkResult.status === "error") {
        return mapAgentError(checkResult, "during self-check");
      }

      // Step 2: Send fix-or-done work prompt (resume the same session).
      const fixPrompt = buildFixOrDonePrompt();
      ctx.promptSinks?.a?.(fixPrompt);
      const fixResult = await sendFollowUp(
        opts.agent,
        checkResult.sessionId,
        fixPrompt,
        ctx.worktreePath,
        ctx.streamSinks?.a,
        undefined,
        ctx.usageSinks?.a,
      );

      if (fixResult.status === "error") {
        return mapAgentError(fixResult, "during fix");
      }

      // Step 3: Verdict follow-up — ask for exactly FIXED or DONE.
      const verdictPrompt = buildFixOrDoneVerdictPrompt();
      ctx.promptSinks?.a?.(verdictPrompt);
      const verdictResult = await sendFollowUp(
        opts.agent,
        fixResult.sessionId,
        verdictPrompt,
        ctx.worktreePath,
        ctx.streamSinks?.a,
        undefined,
        ctx.usageSinks?.a,
      );

      if (verdictResult.status === "error") {
        return mapAgentError(verdictResult, "during fix verdict");
      }

      let verdictCheckResult = verdictResult;
      let result = mapFixOrDoneResponse(
        verdictCheckResult.responseText,
        FIX_OR_DONE_KEYWORDS,
      );

      // Internal clarification retry (same pattern as other stages).
      if (result.outcome === "needs_clarification") {
        const clarifyPrompt = buildClarificationPrompt(
          verdictCheckResult.responseText,
          FIX_OR_DONE_KEYWORDS,
        );
        ctx.promptSinks?.a?.(clarifyPrompt);
        const retryResult = await sendFollowUp(
          opts.agent,
          verdictCheckResult.sessionId ?? fixResult.sessionId,
          clarifyPrompt,
          ctx.worktreePath,
          ctx.streamSinks?.a,
          undefined,
          ctx.usageSinks?.a,
        );

        if (retryResult.status === "error") {
          return mapAgentError(retryResult, "during fix verdict clarification");
        }

        verdictCheckResult = retryResult;
        result = mapFixOrDoneResponse(
          retryResult.responseText,
          FIX_OR_DONE_KEYWORDS,
        );
      }

      // If still ambiguous after the in-session retry, fall back to
      // not_approved so the pipeline loops the self-check again.
      // Treating ambiguity as "completed" would skip the re-check
      // loop when the agent actually said FIXED, and would trigger
      // issue sync even though the verdict is uncertain.
      if (result.outcome === "needs_clarification") {
        result = { outcome: "not_approved", message: result.message };
      }

      // Step 4: Issue description sync (only when self-check is done).
      if (result.outcome === "completed" && verdictCheckResult.sessionId) {
        try {
          const syncPrompt = buildIssueSyncPrompt(ctx, opts);
          ctx.promptSinks?.a?.(syncPrompt);
          const syncResult = await sendFollowUp(
            opts.agent,
            verdictCheckResult.sessionId,
            syncPrompt,
            ctx.worktreePath,
            ctx.streamSinks?.a,
            undefined,
            ctx.usageSinks?.a,
          );

          if (syncResult.status === "success") {
            // Verdict follow-up: ask for sync status report.
            const syncVerdictPrompt = buildIssueSyncVerdictPrompt();
            ctx.promptSinks?.a?.(syncVerdictPrompt);
            const syncVerdictResult = await sendFollowUp(
              opts.agent,
              syncResult.sessionId ?? verdictCheckResult.sessionId,
              syncVerdictPrompt,
              ctx.worktreePath,
              ctx.streamSinks?.a,
              undefined,
              ctx.usageSinks?.a,
            );

            if (syncVerdictResult.status === "success") {
              let parseResult = parseIssueSyncResponse(
                syncVerdictResult.responseText,
              );

              // Clarification retry if the response was malformed.
              if (!parseResult.valid) {
                const clarifyPrompt = buildIssueSyncClarificationPrompt();
                ctx.promptSinks?.a?.(clarifyPrompt);
                const retryResult = await sendFollowUp(
                  opts.agent,
                  syncVerdictResult.sessionId ??
                    syncResult.sessionId ??
                    verdictCheckResult.sessionId,
                  clarifyPrompt,
                  ctx.worktreePath,
                  ctx.streamSinks?.a,
                  undefined,
                  ctx.usageSinks?.a,
                );

                if (retryResult.status === "success") {
                  parseResult = parseIssueSyncResponse(
                    retryResult.responseText,
                  );
                }
                // If retry failed or still invalid, fall through
                // to the valid check below.
              }

              if (parseResult.valid) {
                for (const change of parseResult.changes) {
                  opts.onIssueChange?.(change);
                }
                opts.onIssueSyncStatus?.("completed");
              } else {
                opts.onIssueSyncStatus?.("failed");
              }
            } else {
              opts.onIssueSyncStatus?.("failed");
            }
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
