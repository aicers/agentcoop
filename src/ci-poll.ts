/**
 * Shared CI polling with fix loop.
 *
 * Used by stages 7 (squash) and 8 (review) to poll CI after a
 * force-push or fix push, and optionally invoke the agent to fix
 * failures.  Extracted to avoid duplicating the poll+fix pattern
 * across multiple stage handlers.
 */

import type { AgentAdapter } from "./agent.js";
import type {
  CiRun,
  CiStatus,
  FetchCodeScanningAlertsFn,
  GetCiStatusFn,
} from "./ci.js";
import {
  correlateFindings,
  collectFailureLogs as defaultCollectFailureLogs,
  fetchCodeScanningAlerts as defaultFetchAlerts,
  getCiStatus as defaultGetCiStatus,
  normaliseCiConclusion,
} from "./ci.js";
import { t } from "./i18n/index.js";
import type { StageContext } from "./pipeline.js";
import type { PipelineEventEmitter } from "./pipeline-events.js";
import {
  buildCiFindingsPrompt,
  buildCiFindingsResumePrompt,
  buildCiFixPrompt,
  buildCiFixResumePrompt,
} from "./stage-cicheck.js";
import {
  buildErrorDetail,
  invokeOrResume,
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
  /** Injected for testability. Defaults to `ci.fetchCodeScanningAlerts`. */
  fetchCodeScanningAlerts?: FetchCodeScanningAlertsFn;
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
  /** Pipeline event emitter for diagnostic events. */
  events?: PipelineEventEmitter;
  /**
   * Latest known Agent A session id at the moment the caller hands
   * off to `pollCiAndFix`.  When set, it overrides
   * `ctx.savedAgentASessionId` for seeding the CI loop's own session
   * tracker so the very first CI findings/fix turn resumes the
   * caller's most recent conversation rather than the stage-entry
   * snapshot.
   *
   * Why a separate option instead of relying on `ctx.savedAgentASessionId`:
   * `StageContext` is a one-shot snapshot taken at handler entry, but
   * Stage 7 (`author_fix` → `ci_poll`) and Stage 8 (squash work →
   * verdict → user choice → CI poll) routinely produce a newer Agent
   * A session id within the same handler invocation.  `ctx.onSessionId`
   * persists those externally but does not mutate the snapshot, so
   * without this option the first CI prompt would still fall back to
   * fresh-form even though the live session is known.  Subsequent
   * loop iterations are covered by the helper's local
   * `currentSessionId` which is updated after every agent turn.
   */
  initialAgentASessionId?: string;
  /**
   * Optional callback invoked when CI cannot proceed via the normal
   * fix loop — exhausted fix budget, pending timeout, or an agent
   * error during findings review or fix.  When set, the caller is
   * asked whether to keep trying instead of returning a failure.
   *
   * Returning `true` resumes the loop using the per-reason retry
   * semantics described in {@link ConfirmRetryInfo}; returning
   * `false` (or omitting the callback) falls through to the existing
   * `passed: false` path.  Only wired from Stage 9 — stages 7 and 8
   * already present the engine's `dispatchError` prompt and must
   * not double-ask.
   */
  confirmRetry?: (info: ConfirmRetryInfo) => Promise<boolean>;
}

/**
 * Discriminated reason for which {@link CiPollOptions.confirmRetry}
 * is being invoked.  Each reason carries the metadata its prompt
 * needs to render and is mapped to a distinct retry semantic:
 *
 * - `exhausted` — the fix-attempt budget hit `maxFixAttempts`.
 *   Retry resets the counter to 0 and re-enters the fix loop.
 * - `timeout` — `pollTimeoutMs` elapsed while CI was still pending.
 *   Retry resumes the polling loop without consuming any budget.
 * - `agent_error` — the agent process itself failed during a
 *   findings-review or fix turn.  Retry re-runs the same step and
 *   the relevant counter is decremented to undo the pre-increment
 *   so a permanent failure cannot prematurely exhaust the budget.
 */
export type ConfirmRetryInfo =
  | { reason: "exhausted"; attempts: number; message: string }
  | { reason: "timeout"; seconds: number; message: string }
  | { reason: "agent_error"; detail: string; message: string };

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
  onStatus?: (verdict: string) => void,
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

    onStatus?.(ciStatus.verdict);

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
  const fetchAlerts = options.fetchCodeScanningAlerts ?? defaultFetchAlerts;
  const emptyGrace =
    options.emptyRunsGracePeriodMs ?? DEFAULT_EMPTY_RUNS_GRACE_PERIOD_MS;
  const events = options.events ?? ctx.events;

  // Track failure-fix and findings-review attempts independently so
  // that "pass with findings" never exhausts the failure-fix budget.
  // Always allow at least one findings review even with maxFix = 0.
  const maxFindingsReviews = Math.max(1, maxFix);
  let fixAttempts = 0;
  let findingsReviews = 0;

  // Track the current Agent A session id locally so each iteration
  // resumes the most recent session.  Prefer the caller's
  // `initialAgentASessionId` (the live session id from the same
  // handler invocation) over `ctx.savedAgentASessionId` (the
  // stage-entry snapshot), then update after every agent invocation.
  // When present, the compact resume-form prompt is sent on the live
  // session and the fresh-form prompt is used as the fallback if the
  // session has expired.
  let currentSessionId =
    options.initialAgentASessionId ?? ctx.savedAgentASessionId;

  while (true) {
    // Read HEAD SHA from the worktree so we only consider CI runs
    // triggered by the most recent push (initial or fix).
    const commitSha = readHeadSha(ctx.worktreePath);

    events?.emit("pipeline:ci-poll", { action: "start", sha: commitSha });

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
      (verdict) =>
        events?.emit("pipeline:ci-poll", {
          action: "status",
          sha: commitSha,
          verdict,
        }),
    );

    // Close the polling session for this SHA.  Every `start` gets
    // exactly one matching `done`, regardless of what happens next
    // (timeout, clean pass, findings review, or fix loop).
    events?.emit("pipeline:ci-poll", {
      action: "done",
      sha: commitSha,
      verdict: ciStatus.verdict,
    });

    if (timedOut) {
      const timeoutSeconds = Math.round(pollTimeout / 1000);
      const timeoutMessage = t()["ci.pendingTimeout"](timeoutSeconds);
      if (options.confirmRetry) {
        const keepWaiting = await options.confirmRetry({
          reason: "timeout",
          seconds: timeoutSeconds,
          message: timeoutMessage,
        });
        if (keepWaiting) {
          // Resume polling.  HEAD SHA is re-read at the top of the
          // outer loop, so a fix that landed during the timeout
          // window is automatically picked up.
          continue;
        }
      }
      return { passed: false, message: timeoutMessage };
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

      // Fetch code scanning alerts and correlate to findings so
      // the agent can dismiss false positives by alert number.
      const alerts = fetchAlerts(ctx.owner, ctx.repo, ctx.branch);
      const correlated =
        alerts.length > 0
          ? correlateFindings(ciStatus.findings, alerts)
          : undefined;

      const freshFindingsPrompt = buildCiFindingsPrompt(
        ctx,
        { issueTitle, issueBody },
        ciStatus.findings,
        ciStatus.findingsIncomplete,
        correlated,
      );
      const resumeFindingsPrompt = buildCiFindingsResumePrompt(
        ctx,
        ciStatus.findings,
        ciStatus.findingsIncomplete,
        correlated,
      );
      const findingsUseResume = currentSessionId !== undefined;
      const findingsPrompt = findingsUseResume
        ? resumeFindingsPrompt
        : freshFindingsPrompt;
      ctx.promptSinks?.a?.(findingsPrompt, "ci-fix");
      const reviewResult = await invokeOrResume(
        agent,
        currentSessionId,
        findingsPrompt,
        ctx.worktreePath,
        ctx.streamSinks?.a,
        {
          fallbackPrompt: findingsUseResume ? freshFindingsPrompt : undefined,
          usageSink: ctx.usageSinks?.a,
          promptSink: ctx.promptSinks?.a,
          promptKind: "ci-fix",
        },
      );

      if (reviewResult.sessionId) {
        currentSessionId = reviewResult.sessionId;
        ctx.onSessionId?.("a", reviewResult.sessionId);
      }

      if (reviewResult.status === "error") {
        logAgentFailure(reviewResult, "during CI findings review");
        const detail = buildErrorDetail(reviewResult);
        const errorMessage = t()["ci.agentError"](detail);
        if (options.confirmRetry) {
          const keepTrying = await options.confirmRetry({
            reason: "agent_error",
            detail,
            message: errorMessage,
          });
          if (keepTrying) {
            // Re-run the same findings-review step.  Undo the
            // pre-increment of `findingsReviews` so a permanent
            // agent failure cannot silently exhaust the review
            // budget across user-confirmed retries.
            findingsReviews--;
            continue;
          }
        }
        return { passed: false, message: errorMessage };
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
      const exhaustedMessage = t()["ci.stillFailing"](maxFix);
      if (options.confirmRetry) {
        const keepTrying = await options.confirmRetry({
          reason: "exhausted",
          attempts: fixAttempts,
          message: exhaustedMessage,
        });
        if (keepTrying) {
          // Reset the budget and loop once more before re-checking CI.
          fixAttempts = 0;
        } else {
          return { passed: false, message: exhaustedMessage };
        }
      } else {
        return { passed: false, message: exhaustedMessage };
      }
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

    const freshFixPrompt = buildCiFixPrompt(
      ctx,
      { agent, issueTitle, issueBody },
      failureLogs,
    );
    const resumeFixPrompt = buildCiFixResumePrompt(ctx, failureLogs);
    const fixUseResume = currentSessionId !== undefined;
    const fixPrompt = fixUseResume ? resumeFixPrompt : freshFixPrompt;
    ctx.promptSinks?.a?.(fixPrompt, "ci-fix");
    const fixResult = await invokeOrResume(
      agent,
      currentSessionId,
      fixPrompt,
      ctx.worktreePath,
      ctx.streamSinks?.a,
      {
        fallbackPrompt: fixUseResume ? freshFixPrompt : undefined,
        usageSink: ctx.usageSinks?.a,
        promptSink: ctx.promptSinks?.a,
        promptKind: "ci-fix",
      },
    );

    if (fixResult.sessionId) {
      currentSessionId = fixResult.sessionId;
      ctx.onSessionId?.("a", fixResult.sessionId);
    }

    if (fixResult.status === "error") {
      logAgentFailure(fixResult, "during CI fix");
      const detail = buildErrorDetail(fixResult);
      const errorMessage = t()["ci.agentError"](detail);
      if (options.confirmRetry) {
        const keepTrying = await options.confirmRetry({
          reason: "agent_error",
          detail,
          message: errorMessage,
        });
        if (keepTrying) {
          // Re-run the same fix step.  Undo the pre-increment of
          // `fixAttempts` so a permanent agent failure cannot
          // silently exhaust the fix budget across retries.
          fixAttempts--;
          continue;
        }
      }
      return { passed: false, message: errorMessage };
    }

    // Agent pushed a fix — loop back to poll CI again.
  }
}
