/**
 * Stage 4 — Create PR.
 *
 * Two-step flow:
 *   1. Send a PR creation prompt to Agent A with repo, issue, and
 *      worktree context.
 *   2. Resume the session and explicitly ask for a completion status
 *      (COMPLETED or BLOCKED).
 *
 * If the completion check response is ambiguous, the handler retries
 * by resuming the same session with a clarification prompt.  This
 * avoids re-entering the handler (which would re-run the side-effectful
 * PR creation step).  If clarification also fails, the handler
 * performs a post-condition check (`findPrNumber`) to verify whether
 * a PR was actually created.  If the PR exists, the stage completes;
 * otherwise it reports BLOCKED.
 *
 * `requiresArtifact` is set to `true` so the engine suppresses the
 * "Proceed" option when the agent reports BLOCKED — only Instruct and
 * Halt are available.
 */

import type { AgentAdapter } from "./agent.js";
import { t } from "./i18n/index.js";
import type { StageContext, StageDefinition, StageResult } from "./pipeline.js";
import { findPrNumber as defaultFindPrNumber } from "./pr.js";
import {
  invokeOrResume,
  mapAgentError,
  mapResponseToResult,
  sendFollowUp,
} from "./stage-util.js";
import { buildClarificationPrompt } from "./step-parser.js";

export interface CreatePrStageOptions {
  agent: AgentAdapter;
  issueTitle: string;
  issueBody: string;
  /** Injected for testability. Defaults to `pr.findPrNumber`. */
  findPrNumber?: (
    owner: string,
    repo: string,
    branch: string,
  ) => number | undefined;
}

export function buildCreatePrPrompt(
  ctx: StageContext,
  opts: CreatePrStageOptions,
): string {
  const lines = [
    `You are creating a pull request for the following GitHub issue.`,
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
    `1. Commit any remaining uncommitted changes on the branch.`,
    `2. Push the branch to the remote.`,
    `3. Create a pull request using \`gh pr create\` targeting the default`,
    `   branch.  The PR title should reference the issue number`,
    `   (e.g. "Fix widget rendering (#42)").`,
    `4. In the PR body, include:`,
    `   - A brief summary of the changes`,
    `   - If this PR fully resolves the issue, include "Closes #${ctx.issueNumber}"`,
    `     in the description. If it only partially addresses it,`,
    `     use "Part of #${ctx.issueNumber}" instead and add a`,
    `     "## Not addressed" section listing which issue requirements`,
    `     were not implemented and why.`,
    `   - A "## Test plan" section with a checkbox checklist of items to`,
    `     verify (derived from the issue requirements)`,
    `5. Do NOT merge the PR — just create it.`,
  ];

  if (ctx.userInstruction) {
    lines.push(``, `## Additional feedback`, ``, ctx.userInstruction);
  }

  return lines.join("\n");
}

export const PR_CHECK_KEYWORDS = ["COMPLETED", "BLOCKED"] as const;

export function buildPrCompletionCheckPrompt(): string {
  return [
    `You have finished your PR creation attempt.  Please evaluate the`,
    `result and respond with exactly one of the following keywords:`,
    ``,
    `- COMPLETED — if the pull request was created successfully`,
    `- BLOCKED — if you could not create the PR and need user intervention`,
    ``,
    `Do not include any other commentary — just the keyword.`,
  ].join("\n");
}

export function createCreatePrStageHandler(
  opts: CreatePrStageOptions,
): StageDefinition {
  return {
    name: t()["stage.createPr"],
    number: 4,
    requiresArtifact: true,
    handler: async (ctx: StageContext): Promise<StageResult> => {
      // Step 1: Send the PR creation prompt (resume if saved session).
      const prompt = buildCreatePrPrompt(ctx, opts);
      ctx.promptSinks?.a?.(prompt);
      const prResult = await invokeOrResume(
        opts.agent,
        ctx.savedAgentASessionId,
        prompt,
        ctx.worktreePath,
        ctx.streamSinks?.a,
        undefined,
        ctx.usageSinks?.a,
      );

      if (prResult.sessionId) {
        ctx.onSessionId?.("a", prResult.sessionId);
      }

      if (prResult.status === "error") {
        return mapAgentError(prResult);
      }

      // Step 2: Resume the session and ask for completion status.
      // Clarification is handled internally by resuming the same
      // session, because re-entering the handler would re-run the
      // side-effectful PR creation step.
      const prCheckPrompt = buildPrCompletionCheckPrompt();
      ctx.promptSinks?.a?.(prCheckPrompt);
      let checkResult = await sendFollowUp(
        opts.agent,
        prResult.sessionId,
        prCheckPrompt,
        ctx.worktreePath,
        ctx.streamSinks?.a,
        undefined,
        ctx.usageSinks?.a,
      );

      if (checkResult.status === "error") {
        return mapAgentError(checkResult, "during PR completion check");
      }

      let result = mapResponseToResult(
        checkResult.responseText,
        undefined,
        PR_CHECK_KEYWORDS,
      );

      if (result.outcome === "needs_clarification") {
        const clarifyPrompt = buildClarificationPrompt(
          checkResult.responseText,
          PR_CHECK_KEYWORDS,
        );
        ctx.promptSinks?.a?.(clarifyPrompt);
        const retryResult = await sendFollowUp(
          opts.agent,
          checkResult.sessionId ?? prResult.sessionId,
          clarifyPrompt,
          ctx.worktreePath,
          ctx.streamSinks?.a,
          undefined,
          ctx.usageSinks?.a,
        );

        if (retryResult.status === "error") {
          return mapAgentError(
            retryResult,
            "during PR completion clarification",
          );
        }

        checkResult = retryResult;
        result = mapResponseToResult(
          retryResult.responseText,
          undefined,
          PR_CHECK_KEYWORDS,
        );
      }

      // If still ambiguous after the in-session retry, verify
      // the PR actually exists before proceeding.
      if (result.outcome === "needs_clarification") {
        const prNumber = (opts.findPrNumber ?? defaultFindPrNumber)(
          ctx.owner,
          ctx.repo,
          ctx.branch,
        );
        if (prNumber != null) {
          result = { outcome: "completed", message: result.message };
        } else {
          result = {
            outcome: "blocked",
            message: `${prResult.responseText}\n\n---\n\n${checkResult.responseText}`,
          };
        }
      }

      // When blocked, combine the step 1 diagnostic text with the
      // completion check response so the user can see what went wrong.
      if (result.outcome === "blocked") {
        result.message = `${prResult.responseText}\n\n---\n\n${checkResult.responseText}`;
      }

      return result;
    },
  };
}
