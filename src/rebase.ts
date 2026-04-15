/**
 * Rebase handler — invokes an agent to rebase a feature branch onto
 * the latest main and reports the result via a verdict follow-up.
 *
 * Two-step flow:
 *   1. Work step — agent performs the rebase.
 *   2. Verdict follow-up — agent reports COMPLETED or BLOCKED.
 *
 * Includes substep-scoped keyword validation and a single
 * clarification retry on ambiguous or out-of-scope responses.
 *
 * Extracted from `index.ts` for testability.
 */

import type { AgentAdapter } from "./agent.js";
import type { StageContext } from "./pipeline.js";
import { drainToSink, sendFollowUp } from "./stage-util.js";
import {
  buildClarificationPrompt,
  parseVerdictKeyword,
} from "./step-parser.js";

export const REBASE_KEYWORDS = ["COMPLETED", "BLOCKED"] as const;

export interface RebaseResult {
  success: boolean;
  message: string;
}

export function buildRebasePrompt(
  ctx: StageContext,
  defaultBranch: string,
): string {
  return [
    `You are rebasing a feature branch onto the latest main.`,
    ``,
    `## Repository`,
    `- Owner: ${ctx.owner}`,
    `- Repo: ${ctx.repo}`,
    `- Branch: ${ctx.branch}`,
    `- Worktree: ${ctx.worktreePath}`,
    ``,
    `## Instructions`,
    ``,
    `1. Run \`git fetch origin ${defaultBranch}\` to get the latest main.`,
    `2. Run \`git rebase origin/${defaultBranch}\` to rebase onto main.`,
    `3. Resolve any merge conflicts that arise.`,
    `4. After resolving conflicts, verify the result locally:`,
    `   - Build the project to ensure it compiles.`,
    `   - Run the full test suite to ensure nothing is broken.`,
    `5. Only if the build and all tests pass, force-push the branch:`,
    `   \`git push --force-with-lease\``,
    `6. After a successful force-push, post a brief PR comment noting`,
    `   which main commit the branch was rebased onto and a short`,
    `   summary of resolved conflicts. Use:`,
    `   \`gh pr comment --body "<your summary>"\``,
    `   If no PR exists or the comment fails, continue without failing.`,
    ``,
    `IMPORTANT: If you cannot resolve conflicts cleanly or if the`,
    `build/tests fail after resolution, do NOT push. Instead, abort`,
    `the rebase (\`git rebase --abort\`) and report failure.`,
  ].join("\n");
}

export function buildRebaseVerdictPrompt(): string {
  return [
    `You have finished the rebase attempt.`,
    `Respond with exactly one of the following keywords:`,
    ``,
    `- COMPLETED — if the rebase succeeded and was force-pushed`,
    `- BLOCKED — if you could not resolve conflicts or tests failed`,
    ``,
    `Do not include any other commentary — just the keyword.`,
  ].join("\n");
}

/**
 * Create a rebase handler that invokes the given agent.
 */
export function createRebaseHandler(
  agent: AgentAdapter,
  defaultBranch: string,
): (ctx: StageContext) => Promise<RebaseResult> {
  return async (ctx) => {
    const rebasePrompt = buildRebasePrompt(ctx, defaultBranch);
    ctx.promptSinks?.a?.(rebasePrompt, "work");
    const stream = agent.invoke(rebasePrompt, {
      cwd: ctx.worktreePath,
      onUsage: ctx.usageSinks?.a,
    });
    const drained = ctx.streamSinks?.a
      ? drainToSink(stream, ctx.streamSinks.a)
      : undefined;
    const result = await stream.result;
    if (drained) await drained;

    if (result.sessionId) {
      ctx.onSessionId?.("a", result.sessionId);
    }

    if (result.status === "error") {
      return { success: false, message: result.responseText };
    }

    // Verdict follow-up: ask for exactly COMPLETED or BLOCKED.
    const verdictPrompt = buildRebaseVerdictPrompt();
    ctx.promptSinks?.a?.(verdictPrompt, "verdict-followup", { resume: true });
    let verdictResult = await sendFollowUp(
      agent,
      result.sessionId,
      verdictPrompt,
      ctx.worktreePath,
      ctx.streamSinks?.a,
      undefined,
      ctx.usageSinks?.a,
    );

    if (verdictResult.status === "error") {
      return { success: false, message: verdictResult.responseText };
    }

    let verdict = parseVerdictKeyword(
      verdictResult.responseText,
      REBASE_KEYWORDS,
    );
    if (verdict.keyword !== undefined) {
      ctx.events?.emit("pipeline:verdict", {
        agent: "a",
        keyword: verdict.keyword,
        raw: verdictResult.responseText,
      });
    }

    // Clarification retry if ambiguous, extra commentary, or
    // multiple valid keywords.
    if (verdict.keyword === undefined) {
      const clarifyPrompt = buildClarificationPrompt(
        verdictResult.responseText,
        REBASE_KEYWORDS,
      );
      ctx.promptSinks?.a?.(clarifyPrompt, "verdict-followup", { resume: true });
      const retryResult = await sendFollowUp(
        agent,
        verdictResult.sessionId ?? result.sessionId,
        clarifyPrompt,
        ctx.worktreePath,
        ctx.streamSinks?.a,
        undefined,
        ctx.usageSinks?.a,
      );

      if (retryResult.status === "error") {
        return { success: false, message: retryResult.responseText };
      }

      verdictResult = retryResult;
      verdict = parseVerdictKeyword(
        verdictResult.responseText,
        REBASE_KEYWORDS,
      );
      if (verdict.keyword !== undefined) {
        ctx.events?.emit("pipeline:verdict", {
          agent: "a",
          keyword: verdict.keyword,
          raw: verdictResult.responseText,
        });
      }
    }

    const success = verdict.keyword?.toUpperCase() === "COMPLETED";
    return { success, message: result.responseText };
  };
}
