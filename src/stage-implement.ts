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
import type { StageContext, StageDefinition, StageResult } from "./pipeline.js";
import {
  mapAgentError,
  mapResponseToResult,
  sendFollowUp,
} from "./stage-util.js";

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
    `worktree directory listed above.  Make sure the code compiles and any`,
    `existing tests still pass.`,
  ];

  if (ctx.userInstruction) {
    lines.push(``, `## Additional feedback`, ``, ctx.userInstruction);
  }

  return lines.join("\n");
}

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
    name: "Implement",
    number: 2,
    handler: async (ctx: StageContext): Promise<StageResult> => {
      // Step 1: Send the implementation prompt.
      const prompt = buildImplementPrompt(ctx, opts);
      const implStream = opts.agent.invoke(prompt, { cwd: ctx.worktreePath });
      const implResult = await implStream.result;

      if (implResult.status === "error") {
        return mapAgentError(implResult);
      }

      // Step 2: Resume the session and ask for completion status.
      const checkResult = await sendFollowUp(
        opts.agent,
        implResult.sessionId,
        buildCompletionCheckPrompt(),
        ctx.worktreePath,
      );

      if (checkResult.status === "error") {
        return mapAgentError(checkResult, "during completion check");
      }

      return mapResponseToResult(checkResult.responseText);
    },
  };
}
