/**
 * Stage 7 — Squash commits.
 *
 * Two-step flow + internal CI polling:
 *   1. Send a squash prompt to Agent A instructing it to squash all
 *      branch commits into one and force-push.
 *   2. Resume the session with a completion check (COMPLETED/BLOCKED).
 *   3. Poll CI after force-push.  If CI fails, the agent is invoked
 *      to fix the issue and CI is re-polled (internal loop, max 3).
 *
 * `requiresArtifact` is true because the squash must succeed for the
 * review stage to proceed.
 */

import type { AgentAdapter } from "./agent.js";
import type { CiStatus } from "./ci.js";
import {
  collectFailureLogs as defaultCollectFailureLogs,
  getCiStatus as defaultGetCiStatus,
} from "./ci.js";
import { type CiPollResult, pollCiAndFix } from "./ci-poll.js";
import type { StageContext, StageDefinition, StageResult } from "./pipeline.js";
import {
  mapAgentError,
  mapResponseToResult,
  sendFollowUp,
} from "./stage-util.js";
import { buildClarificationPrompt } from "./step-parser.js";

// ---- defaults ----------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_POLL_TIMEOUT_MS = 600_000;

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- public types ------------------------------------------------------------

export interface SquashStageOptions {
  agent: AgentAdapter;
  issueTitle: string;
  issueBody: string;
  /** Injected for testability. */
  getCiStatus?: (owner: string, repo: string, branch: string) => CiStatus;
  /** Injected for testability. */
  collectFailureLogs?: (owner: string, repo: string, runId: number) => string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Max CI fix attempts. Default 3. */
  maxFixAttempts?: number;
  /** Injected for testability. */
  delay?: (ms: number) => Promise<void>;
}

// ---- prompt builders ---------------------------------------------------------

export function buildSquashPrompt(
  ctx: StageContext,
  opts: SquashStageOptions,
): string {
  const lines = [
    `You are squashing commits for the following GitHub issue.`,
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
    `1. Squash all commits on this branch into a single commit.  Use an`,
    `   interactive rebase or reset-based approach — whichever is simpler.`,
    `2. Write a clear, concise commit message that summarises all changes`,
    `   made for this issue.  Reference the issue number`,
    `   (e.g. "Implement widget rendering (#42)").`,
    `3. Force-push the branch (\`git push --force-with-lease\`).`,
  ];

  if (ctx.userInstruction) {
    lines.push(``, `## Additional feedback`, ``, ctx.userInstruction);
  }

  return lines.join("\n");
}

export function buildSquashCompletionCheckPrompt(): string {
  return [
    `You have finished your squash attempt.  Please evaluate the result`,
    `and respond with exactly one of the following keywords:`,
    ``,
    `- COMPLETED — if the commits were squashed and force-pushed`,
    `- BLOCKED — if you could not squash and need user intervention`,
    ``,
    `If BLOCKED, add a brief reason on the next line explaining what`,
    `went wrong.`,
  ].join("\n");
}

// ---- handler -----------------------------------------------------------------

export function createSquashStageHandler(
  opts: SquashStageOptions,
): StageDefinition {
  return {
    name: "Squash commits",
    number: 7,
    requiresArtifact: true,
    handler: async (ctx: StageContext): Promise<StageResult> => {
      // Step 1: Send the squash prompt.
      const prompt = buildSquashPrompt(ctx, opts);
      const squashStream = opts.agent.invoke(prompt, {
        cwd: ctx.worktreePath,
      });
      const squashResult = await squashStream.result;

      if (squashResult.status === "error") {
        return mapAgentError(squashResult, "during squash");
      }

      // Step 2: Completion check (same internal-clarification pattern as
      // stage 4).
      let checkResult = await sendFollowUp(
        opts.agent,
        squashResult.sessionId,
        buildSquashCompletionCheckPrompt(),
        ctx.worktreePath,
      );

      if (checkResult.status === "error") {
        return mapAgentError(checkResult, "during squash completion check");
      }

      let result = mapResponseToResult(checkResult.responseText);

      if (result.outcome === "needs_clarification" && checkResult.sessionId) {
        const retryResult = await sendFollowUp(
          opts.agent,
          checkResult.sessionId,
          buildClarificationPrompt(checkResult.responseText),
          ctx.worktreePath,
        );

        if (retryResult.status === "error") {
          return mapAgentError(
            retryResult,
            "during squash completion clarification",
          );
        }

        checkResult = retryResult;
        result = mapResponseToResult(retryResult.responseText);
      }

      if (result.outcome === "blocked") {
        result.message = `${squashResult.responseText}\n\n---\n\n${checkResult.responseText}`;
        return result;
      }

      if (result.outcome !== "completed") {
        return result;
      }

      // Step 3: Poll CI after force-push.
      const ciResult: CiPollResult = await pollCiAndFix({
        ctx,
        agent: opts.agent,
        issueTitle: opts.issueTitle,
        issueBody: opts.issueBody,
        getCiStatus: opts.getCiStatus ?? defaultGetCiStatus,
        collectFailureLogs:
          opts.collectFailureLogs ?? defaultCollectFailureLogs,
        pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        pollTimeoutMs: opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
        maxFixAttempts: opts.maxFixAttempts,
        delay: opts.delay ?? defaultDelay,
      });

      if (!ciResult.passed) {
        return { outcome: "error", message: ciResult.message };
      }

      return {
        outcome: "completed",
        message: "Commits squashed and CI passed.",
      };
    },
  };
}
