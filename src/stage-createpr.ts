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
  type VerdictContext,
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

/**
 * Compact resume-form prompt for stage 4 — sent when the agent
 * already has the issue context from a prior stage's session.
 */
export function buildCreatePrResumePrompt(ctx: StageContext): string {
  const lines = [
    `Create a pull request for issue #${ctx.issueNumber}.`,
    ``,
    `1. Commit any remaining uncommitted changes on the branch.`,
    `2. Push the branch to the remote.`,
    `3. Create a pull request using \`gh pr create\` targeting the default`,
    `   branch.  The PR title should reference the issue number`,
    `   (e.g. "Fix widget rendering (#${ctx.issueNumber})").`,
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
    `Reply with exactly one keyword (no commentary):`,
    `COMPLETED if the pull request was created successfully,`,
    `BLOCKED if you could not create the PR and need user intervention.`,
  ].join("\n");
}

export function createCreatePrStageHandler(
  opts: CreatePrStageOptions,
): StageDefinition {
  return {
    name: t()["stage.createPr"],
    number: 4,
    primaryAgent: "a",
    requiresArtifact: true,
    handler: async (ctx: StageContext): Promise<StageResult> => {
      // Step 1: Send the PR creation prompt (resume if saved session).
      const freshPrompt = buildCreatePrPrompt(ctx, opts);
      const resumePrompt = buildCreatePrResumePrompt(ctx);
      const useResume = ctx.savedAgentASessionId !== undefined;
      const prompt = useResume ? resumePrompt : freshPrompt;
      ctx.promptSinks?.a?.(prompt, "work");
      const prResult = await invokeOrResume(
        opts.agent,
        ctx.savedAgentASessionId,
        prompt,
        ctx.worktreePath,
        ctx.streamSinks?.a,
        {
          fallbackPrompt: useResume ? freshPrompt : undefined,
          usageSink: ctx.usageSinks?.a,
          promptSink: ctx.promptSinks?.a,
          promptKind: "work",
        },
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
      ctx.promptSinks?.a?.(prCheckPrompt, "verdict-followup", { resume: true });
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

      const verdictCtx: VerdictContext | undefined = ctx.events
        ? { events: ctx.events, agent: "a" }
        : undefined;

      let result = mapResponseToResult(
        checkResult.responseText,
        undefined,
        PR_CHECK_KEYWORDS,
        verdictCtx,
      );

      if (result.outcome === "needs_clarification") {
        const clarifyPrompt = buildClarificationPrompt(
          checkResult.responseText,
          PR_CHECK_KEYWORDS,
        );
        ctx.promptSinks?.a?.(clarifyPrompt, "verdict-followup", {
          resume: true,
        });
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
          checkResult.responseText,
          undefined,
          PR_CHECK_KEYWORDS,
          verdictCtx,
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
