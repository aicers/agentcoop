/**
 * Shared CI polling with fix loop.
 *
 * Used by stages 7 (squash) and 8 (review) to poll CI after a
 * force-push or fix push, and optionally invoke the agent to fix
 * failures.  Extracted to avoid duplicating the poll+fix pattern
 * across multiple stage handlers.
 */

import type { AgentAdapter } from "./agent.js";
import type { CiRun, CiStatus, GetCiStatusFn } from "./ci.js";
import {
  collectFailureLogs as defaultCollectFailureLogs,
  getCiStatus as defaultGetCiStatus,
  normaliseCiConclusion,
} from "./ci.js";
import { t } from "./i18n/index.js";
import type { StageContext } from "./pipeline.js";
import { buildCiFindingsPrompt, buildCiFixPrompt } from "./stage-cicheck.js";
import {
  buildErrorDetail,
  drainToSink,
  logAgentFailure,
} from "./stage-util.js";
import { getHeadSha as defaultGetHeadSha } from "./worktree.js";

// ---- defaults ----------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_POLL_TIMEOUT_MS = 600_000; // 10 minutes
const DEFAULT_MAX_FIX_ATTEMPTS = 3;
const DEFAULT_EMPTY_RUNS_GRACE_PERIOD_MS = 60_000; // 1 minute

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
  getCiStatus?: GetCiStatusFn;
  /** Injected for testability. Defaults to `ci.collectFailureLogs`. */
  collectFailureLogs?: (owner: string, repo: string, run: CiRun) => string;
  /**
   * Read the current HEAD SHA from the worktree.  Called before each
   * CI poll so that fix pushes automatically target the new commit.
   * Injected for testability.  Defaults to `worktree.getHeadSha`.
   */
  getHeadSha?: (cwd: string) => string;
  /** Delay in ms between polls when CI is pending. Default 30 000. */
  pollIntervalMs?: number;
  /** Max time in ms to wait for pending CI. Default 600 000 (10 min). */
  pollTimeoutMs?: number;
  /** Maximum number of fix attempts before giving up. Default 3. */
  maxFixAttempts?: number;
  /**
   * How long to keep polling when SHA filtering returns zero runs
   * (workflow not yet created).  After this period, an empty "pass"
   * is accepted (covers repos with no CI or skipped workflows).
   * Default 60 000 (1 min).
   */
  emptyRunsGracePeriodMs?: number;
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
  getCiStatus: GetCiStatusFn,
  pollInterval: number,
  pollTimeout: number,
  delay: (ms: number) => Promise<void>,
  commitSha?: string,
  emptyRunsGracePeriod?: number,
): Promise<{ timedOut: boolean; ciStatus: CiStatus }> {
  const startTime = Date.now();

  while (true) {
    let ciStatus: CiStatus;
    try {
      ciStatus = getCiStatus(owner, repo, branch, commitSha);
    } catch (err) {
      // Transient lookup error — log and retry on the next poll cycle.
      console.warn(
        `CI status lookup failed (will retry): ${err instanceof Error ? err.message : err}`,
      );
      const elapsed = Date.now() - startTime;
      if (elapsed >= pollTimeout) {
        return {
          timedOut: true,
          ciStatus: {
            verdict: "pending" as const,
            runs: [],
            findings: [],
            findingsIncomplete: false,
          },
        };
      }
      await delay(pollInterval);
      continue;
    }

    const elapsed = Date.now() - startTime;

    if (ciStatus.verdict !== "pending") {
      // When SHA-filtering, an empty "pass" may mean the workflow
      // hasn't been created yet.  Keep polling until the grace period
      // elapses; after that, accept the verdict (no CI / skipped).
      const withinGrace =
        commitSha &&
        emptyRunsGracePeriod !== undefined &&
        ciStatus.runs.length === 0 &&
        elapsed < emptyRunsGracePeriod;

      if (!withinGrace) {
        return { timedOut: false, ciStatus };
      }
    }

    if (elapsed >= pollTimeout) {
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
  const readHeadSha = options.getHeadSha ?? defaultGetHeadSha;
  const emptyGrace =
    options.emptyRunsGracePeriodMs ?? DEFAULT_EMPTY_RUNS_GRACE_PERIOD_MS;

  // Track failure-fix and findings-review attempts independently so
  // that "pass with findings" never exhausts the failure-fix budget.
  // Always allow at least one findings review even with maxFix = 0.
  const maxFindingsReviews = Math.max(1, maxFix);
  let fixAttempts = 0;
  let findingsReviews = 0;

  while (true) {
    // Read HEAD SHA from the worktree so we only consider CI runs
    // triggered by the most recent push (initial or fix).
    const commitSha = readHeadSha(ctx.worktreePath);

    const { timedOut, ciStatus } = await waitForCi(
      ctx.owner,
      ctx.repo,
      ctx.branch,
      getCiStatus,
      pollInterval,
      pollTimeout,
      delay,
      commitSha,
      emptyGrace,
    );

    if (timedOut) {
      return {
        passed: false,
        message: t()["ci.pendingTimeout"](Math.round(pollTimeout / 1000)),
      };
    }

    if (
      ciStatus.verdict === "pass" &&
      ciStatus.findings.length === 0 &&
      !ciStatus.findingsIncomplete
    ) {
      return { passed: true, message: t()["ci.passed"] };
    }

    // CI passed with findings — present for agent review.
    if (ciStatus.verdict === "pass") {
      if (findingsReviews >= maxFindingsReviews) {
        // Findings-review budget exhausted — accept as passed.
        return { passed: true, message: t()["ci.passedWithFindings"] };
      }
      findingsReviews++;

      const shaBeforeReview = readHeadSha(ctx.worktreePath);

      const findingsPrompt = buildCiFindingsPrompt(
        ctx,
        { issueTitle, issueBody },
        ciStatus.findings,
        ciStatus.findingsIncomplete,
      );
      ctx.promptSinks?.a?.(findingsPrompt);
      const reviewStream = agent.invoke(findingsPrompt, {
        cwd: ctx.worktreePath,
        onUsage: ctx.usageSinks?.a,
      });
      const drained = ctx.streamSinks?.a
        ? drainToSink(reviewStream, ctx.streamSinks.a)
        : undefined;
      const reviewResult = await reviewStream.result;
      if (drained) await drained;

      if (reviewResult.sessionId) {
        ctx.onSessionId?.("a", reviewResult.sessionId);
      }

      if (reviewResult.status === "error") {
        logAgentFailure(reviewResult, "during CI findings review");
        const detail = buildErrorDetail(reviewResult);
        return {
          passed: false,
          message: t()["ci.agentError"](detail),
        };
      }

      const shaAfterReview = readHeadSha(ctx.worktreePath);
      if (shaBeforeReview !== shaAfterReview) {
        // Agent pushed changes — re-poll CI without consuming
        // the failure-fix budget.
        continue;
      }

      // Agent reviewed but did not push — findings acknowledged.
      return { passed: true, message: t()["ci.passedWithFindings"] };
    }

    // CI failed — if we've exhausted fix attempts, give up.
    if (fixAttempts >= maxFix) {
      return {
        passed: false,
        message: t()["ci.stillFailing"](maxFix),
      };
    }
    fixAttempts++;

    // Collect failure logs and send fix prompt to the agent.
    const failedRuns = ciStatus.runs.filter((r) => {
      const conclusion = normaliseCiConclusion(r);
      return conclusion === "failure" || conclusion === "cancelled";
    });

    const logSections: string[] = [];
    for (const run of failedRuns) {
      const logs = collectLogs(ctx.owner, ctx.repo, run);
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
    ctx.promptSinks?.a?.(fixPrompt);
    const fixStream = agent.invoke(fixPrompt, {
      cwd: ctx.worktreePath,
      onUsage: ctx.usageSinks?.a,
    });
    const drained = ctx.streamSinks?.a
      ? drainToSink(fixStream, ctx.streamSinks.a)
      : undefined;
    const fixResult = await fixStream.result;
    if (drained) await drained;

    if (fixResult.sessionId) {
      ctx.onSessionId?.("a", fixResult.sessionId);
    }

    if (fixResult.status === "error") {
      logAgentFailure(fixResult, "during CI fix");
      const detail = buildErrorDetail(fixResult);
      return {
        passed: false,
        message: t()["ci.agentError"](detail),
      };
    }

    // Agent pushed a fix — loop back to poll CI again.
  }
}
