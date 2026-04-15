/**
 * Stage 2 — Implementation.
 *
 * Two-step flow:
 *   1. Send an implementation prompt to Agent A with repo, issue, and
 *      worktree context.
 *   2. Resume the session and explicitly ask for a completion status
 *      (COMPLETED or BLOCKED).
 */

import type { AgentAdapter } from "./agent.js";
import { t } from "./i18n/index.js";
import type { StageContext, StageDefinition, StageResult } from "./pipeline.js";
import {
  invokeOrResume,
  mapAgentError,
  mapResponseToResult,
  sendFollowUp,
  type VerdictContext,
} from "./stage-util.js";
import { buildClarificationPrompt } from "./step-parser.js";

export interface ImplementStageOptions {
  agent: AgentAdapter;
  issueTitle: string;
  issueBody: string;
}

export function buildImplementPrompt(
  ctx: StageContext,
  opts: ImplementStageOptions,
): string {
  const lines = [
    `You are implementing a solution for the following GitHub issue.`,
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
    `Implement the changes required to resolve this issue.  Work inside the`,
    `worktree directory listed above — it is freshly based on the latest`,
    `remote default branch, so you are working on top of the most recent`,
    `upstream state.  Make sure the code compiles and any existing tests`,
    `still pass.`,
    ``,
    `If the project uses external services (databases, message brokers,`,
    `dev servers, etc.), start them using whatever tools the project`,
    `provides (Docker Compose, \`pnpm dev\`, setup scripts, etc.) and run`,
    `the full test suite against them.  If a port conflict occurs, change`,
    `the port rather than skipping the service.`,
  ];

  if (ctx.userInstruction) {
    lines.push(``, `## Additional feedback`, ``, ctx.userInstruction);
  }

  return lines.join("\n");
}

export const IMPLEMENT_CHECK_KEYWORDS = ["COMPLETED", "BLOCKED"] as const;

export function buildCompletionCheckPrompt(): string {
  return [
    `You have finished your implementation attempt.  Please evaluate the`,
    `result and respond with exactly one of the following keywords:`,
    ``,
    `- COMPLETED — if the implementation is finished and working`,
    `- BLOCKED — if you cannot proceed and need user intervention`,
    ``,
    `Do not include any other commentary — just the keyword.`,
  ].join("\n");
}

export function createImplementStageHandler(
  opts: ImplementStageOptions,
): StageDefinition {
  return {
    name: t()["stage.implement"],
    number: 2,
    primaryAgent: "a",
    handler: async (ctx: StageContext): Promise<StageResult> => {
      // Step 1: Send the implementation prompt (resume if saved session).
      const prompt = buildImplementPrompt(ctx, opts);
      ctx.promptSinks?.a?.(prompt, "work");
      const implResult = await invokeOrResume(
        opts.agent,
        ctx.savedAgentASessionId,
        prompt,
        ctx.worktreePath,
        ctx.streamSinks?.a,
        undefined,
        ctx.usageSinks?.a,
      );

      if (implResult.sessionId) {
        ctx.onSessionId?.("a", implResult.sessionId);
      }

      if (implResult.status === "error") {
        return mapAgentError(implResult);
      }

      // Step 2: Resume the session and ask for completion status.
      const checkPrompt = buildCompletionCheckPrompt();
      ctx.promptSinks?.a?.(checkPrompt, "verdict-followup", { resume: true });
      const checkResult = await sendFollowUp(
        opts.agent,
        implResult.sessionId,
        checkPrompt,
        ctx.worktreePath,
        ctx.streamSinks?.a,
        undefined,
        ctx.usageSinks?.a,
      );

      if (checkResult.status === "error") {
        return mapAgentError(checkResult, "during completion check");
      }

      const verdictCtx: VerdictContext | undefined = ctx.events
        ? { events: ctx.events, agent: "a" }
        : undefined;

      let result = mapResponseToResult(
        checkResult.responseText,
        undefined,
        IMPLEMENT_CHECK_KEYWORDS,
        verdictCtx,
      );

      // Internal clarification retry (same pattern as stage 4 / stage 8).
      if (result.outcome === "needs_clarification") {
        const clarifyPrompt = buildClarificationPrompt(
          checkResult.responseText,
          IMPLEMENT_CHECK_KEYWORDS,
        );
        ctx.promptSinks?.a?.(clarifyPrompt, "verdict-followup", {
          resume: true,
        });
        const retryResult = await sendFollowUp(
          opts.agent,
          checkResult.sessionId ?? implResult.sessionId,
          clarifyPrompt,
          ctx.worktreePath,
          ctx.streamSinks?.a,
          undefined,
          ctx.usageSinks?.a,
        );

        if (retryResult.status === "error") {
          return mapAgentError(retryResult, "during completion clarification");
        }

        result = mapResponseToResult(
          retryResult.responseText,
          undefined,
          IMPLEMENT_CHECK_KEYWORDS,
          verdictCtx,
        );
      }

      // If still ambiguous after the in-session retry, surface a
      // blocked condition so the user can decide how to proceed.
      // Treating ambiguity as "completed" could mask a real BLOCKED
      // and send the pipeline into self-check on an unfinished branch.
      if (result.outcome === "needs_clarification") {
        result = { outcome: "blocked", message: result.message };
      }

      return result;
    },
  };
}
