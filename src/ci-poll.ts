/**
 * Shared CI polling with fix loop.
 *
 * Used by stages 7 (squash) and 8 (review) to poll CI after a
 * force-push or fix push, and optionally invoke the agent to fix
 * failures.  Extracted to avoid duplicating the poll+fix pattern
 * across multiple stage handlers.
 */

import type { AgentAdapter } from "./agent.js";
import type { CiStatus } from "./ci.js";
import {
  collectFailureLogs as defaultCollectFailureLogs,
  getCiStatus as defaultGetCiStatus,
  normaliseCiConclusion,
} from "./ci.js";
import type { StageContext } from "./pipeline.js";
import { buildCiFixPrompt } from "./stage-cicheck.js";

// ---- defaults ----------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_POLL_TIMEOUT_MS = 600_000; // 10 minutes
const DEFAULT_MAX_FIX_ATTEMPTS = 3;

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- public types ------------------------------------------------------------

export interface CiPollOptions {
  ctx: StageContext;
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
  /** Maximum number of fix attempts before giving up. Default 3. */
  maxFixAttempts?: number;
  /** Injected for testability. Defaults to a real delay function. */
  delay?: (ms: number) => Promise<void>;
}

export interface CiPollResult {
  /** Whether CI ultimately passed. */
  passed: boolean;
  /** Descriptive message (error detail on failure, success note on pass). */
  message: string;
}

// ---- implementation ----------------------------------------------------------

/**
 * Poll CI until it completes.  Returns the CI status once it's no
 * longer pending, or an error result on timeout.
 */
async function waitForCi(
  owner: string,
  repo: string,
  branch: string,
  getCiStatus: (owner: string, repo: string, branch: string) => CiStatus,
  pollInterval: number,
  pollTimeout: number,
  delay: (ms: number) => Promise<void>,
): Promise<{ timedOut: boolean; ciStatus: CiStatus }> {
  const startTime = Date.now();

  while (true) {
    const ciStatus = getCiStatus(owner, repo, branch);

    if (ciStatus.verdict !== "pending") {
      return { timedOut: false, ciStatus };
    }

    if (Date.now() - startTime >= pollTimeout) {
      return { timedOut: true, ciStatus };
    }

    await delay(pollInterval);
  }
}

/**
 * Poll CI and, on failure, invoke the agent to fix the issue and
 * re-poll.  Repeats up to `maxFixAttempts` times.
 *
 * Returns `{ passed: true }` when CI passes, or
 * `{ passed: false, message }` when all fix attempts are exhausted
 * or CI times out.
 */
export async function pollCiAndFix(
  options: CiPollOptions,
): Promise<CiPollResult> {
  const getCiStatus = options.getCiStatus ?? defaultGetCiStatus;
  const collectLogs = options.collectFailureLogs ?? defaultCollectFailureLogs;
  const pollInterval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeout = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const maxFix = options.maxFixAttempts ?? DEFAULT_MAX_FIX_ATTEMPTS;
  const delay = options.delay ?? defaultDelay;

  const { ctx, agent, issueTitle, issueBody } = options;

  for (let attempt = 0; attempt <= maxFix; attempt++) {
    const { timedOut, ciStatus } = await waitForCi(
      ctx.owner,
      ctx.repo,
      ctx.branch,
      getCiStatus,
      pollInterval,
      pollTimeout,
      delay,
    );

    if (timedOut) {
      return {
        passed: false,
        message:
          `CI checks still pending after ${Math.round(pollTimeout / 1000)}s. ` +
          `The pipeline cannot proceed until CI completes.`,
      };
    }

    if (ciStatus.verdict === "pass") {
      return { passed: true, message: "CI checks passed." };
    }

    // CI failed — if we've exhausted fix attempts, give up.
    if (attempt >= maxFix) {
      return {
        passed: false,
        message: `CI still failing after ${maxFix} fix attempt(s).`,
      };
    }

    // Collect failure logs and send fix prompt to the agent.
    const failedRuns = ciStatus.runs.filter((r) => {
      const conclusion = normaliseCiConclusion(r);
      return conclusion === "failure" || conclusion === "cancelled";
    });

    const logSections: string[] = [];
    for (const run of failedRuns) {
      const logs = collectLogs(ctx.owner, ctx.repo, run.databaseId);
      if (logs) {
        logSections.push(`### ${run.name} (run ${run.databaseId})\n\n${logs}`);
      }
    }

    const failureLogs =
      logSections.length > 0
        ? logSections.join("\n\n")
        : "No detailed failure logs available.";

    const fixPrompt = buildCiFixPrompt(
      ctx,
      { agent, issueTitle, issueBody },
      failureLogs,
    );
    const fixStream = agent.invoke(fixPrompt, { cwd: ctx.worktreePath });
    const fixResult = await fixStream.result;

    if (fixResult.status === "error") {
      const detail =
        fixResult.stderrText || fixResult.errorType || "unknown error";
      return {
        passed: false,
        message: `Agent error during CI fix: ${detail}`,
      };
    }

    // Agent pushed a fix — loop back to poll CI again.
  }

  // Should not reach here, but guard.
  return { passed: false, message: "CI fix loop exhausted." };
}
