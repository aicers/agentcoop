/**
 * Stage 5 — CI check loop.
 *
 * Polls CI status for the branch.  When CI is pending the handler waits
 * internally (without consuming the engine's auto-budget).  When CI
 * passes the stage completes.  When CI fails the handler collects
 * failure logs, sends them to the agent for a fix, and returns
 * `"not_approved"` so the engine loops back for another CI poll.
 *
 * The engine's default auto-budget (3) handles the "3 automatic /
 * 4th asks user" requirement for fix iterations.
 */

import type { AgentAdapter } from "./agent.js";
import type { CiStatus } from "./ci.js";
import {
  collectFailureLogs as defaultCollectFailureLogs,
  getCiStatus as defaultGetCiStatus,
  normaliseCiConclusion,
} from "./ci.js";
import type { StageContext, StageDefinition, StageResult } from "./pipeline.js";
import { mapAgentError } from "./stage-util.js";

// ---- defaults --------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_POLL_TIMEOUT_MS = 600_000; // 10 minutes

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- public types ----------------------------------------------------------

export interface CiCheckStageOptions {
  agent: AgentAdapter;
  issueTitle: string;
  issueBody: string;
  /** Injected for testability. Defaults to `ci.getCiStatus`. */
  getCiStatus?: (owner: string, repo: string, branch: string) => CiStatus;
  /** Injected for testability. Defaults to `ci.collectFailureLogs`. */
  collectFailureLogs?: (owner: string, repo: string, runId: number) => string;
  /** Delay in ms between polls when CI is pending. Default 30 000. */
  pollIntervalMs?: number;
  /** Max time in ms to wait for pending CI. Default 600 000 (10 min). */
  pollTimeoutMs?: number;
  /** Injected for testability. Defaults to a real delay function. */
  delay?: (ms: number) => Promise<void>;
}

// ---- prompt builders -------------------------------------------------------

export function buildCiFixPrompt(
  ctx: StageContext,
  opts: CiCheckStageOptions,
  failureLogs: string,
): string {
  const lines = [
    `You are fixing CI failures for the following GitHub issue.`,
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
    `## CI Failure Logs`,
    ``,
    failureLogs || "No detailed failure logs available.",
    ``,
    `## Instructions`,
    ``,
    `Diagnose and fix the CI failures shown above.  After making your`,
    `changes, commit and push the branch so a new CI run is triggered.`,
  ];

  if (ctx.userInstruction) {
    lines.push(``, `## Additional feedback`, ``, ctx.userInstruction);
  }

  return lines.join("\n");
}

// ---- handler ---------------------------------------------------------------

export function createCiCheckStageHandler(
  opts: CiCheckStageOptions,
): StageDefinition {
  const getCiStatus = opts.getCiStatus ?? defaultGetCiStatus;
  const collectLogs = opts.collectFailureLogs ?? defaultCollectFailureLogs;
  const pollInterval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeout = opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const delay = opts.delay ?? defaultDelay;

  return {
    name: "CI check",
    number: 5,
    handler: async (ctx: StageContext): Promise<StageResult> => {
      // ---- poll for CI completion ------------------------------------------

      const startTime = Date.now();

      let ciStatus: CiStatus;
      while (true) {
        ciStatus = getCiStatus(ctx.owner, ctx.repo, ctx.branch);

        if (ciStatus.verdict !== "pending") break;

        if (Date.now() - startTime >= pollTimeout) {
          return {
            outcome: "error",
            message:
              `CI checks still pending after ${Math.round(pollTimeout / 1000)}s. ` +
              `The pipeline cannot proceed until CI completes.`,
          };
        }

        await delay(pollInterval);
      }

      // ---- CI passed -------------------------------------------------------

      if (ciStatus.verdict === "pass") {
        return { outcome: "completed", message: "CI checks passed." };
      }

      // ---- CI failed — collect logs and send to agent ----------------------

      const failedRuns = ciStatus.runs.filter((r) => {
        const conclusion = normaliseCiConclusion(r);
        return conclusion === "failure" || conclusion === "cancelled";
      });

      const logSections: string[] = [];
      for (const run of failedRuns) {
        const logs = collectLogs(ctx.owner, ctx.repo, run.databaseId);
        if (logs) {
          logSections.push(
            `### ${run.name} (run ${run.databaseId})\n\n${logs}`,
          );
        }
      }

      const failureLogs =
        logSections.length > 0
          ? logSections.join("\n\n")
          : "No detailed failure logs available.";

      const prompt = buildCiFixPrompt(ctx, opts, failureLogs);
      const fixStream = opts.agent.invoke(prompt, { cwd: ctx.worktreePath });
      const fixResult = await fixStream.result;

      if (fixResult.status === "error") {
        return mapAgentError(fixResult, "during CI fix");
      }

      // Return not_approved so the engine loops back to poll CI again.
      return { outcome: "not_approved", message: fixResult.responseText };
    },
  };
}
