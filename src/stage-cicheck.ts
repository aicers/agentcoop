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
import type { CiFinding, CiRun, CiStatus, GetCiStatusFn } from "./ci.js";
import {
  collectFailureLogs as defaultCollectFailureLogs,
  getCiStatus as defaultGetCiStatus,
  normaliseCiConclusion,
} from "./ci.js";
import { t } from "./i18n/index.js";
import { buildPrSyncInstructions } from "./issue-sync.js";
import type { StageContext, StageDefinition, StageResult } from "./pipeline.js";
import {
  buildDocConsistencyInstructions,
  invokeOrResume,
  mapAgentError,
} from "./stage-util.js";
import { getHeadSha as defaultGetHeadSha } from "./worktree.js";

// ---- defaults --------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_POLL_TIMEOUT_MS = 600_000; // 10 minutes
const DEFAULT_EMPTY_RUNS_GRACE_PERIOD_MS = 60_000; // 1 minute

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- public types ----------------------------------------------------------

export interface CiCheckStageOptions {
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
  /**
   * How long to keep polling when SHA filtering returns zero runs.
   * After this period, an empty "pass" is accepted.  Default 60 000.
   */
  emptyRunsGracePeriodMs?: number;
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
    `changes:`,
    ``,
    buildDocConsistencyInstructions(),
    ``,
    `${buildPrSyncInstructions(ctx.issueNumber)}`,
    ``,
    `Then commit and push the branch so a new CI run is triggered.`,
  ];

  if (ctx.userInstruction) {
    lines.push(``, `## Additional feedback`, ``, ctx.userInstruction);
  }

  return lines.join("\n");
}

/**
 * Format findings into a structured block for inclusion in the
 * findings-review prompt.
 */
function formatFindings(findings: CiFinding[]): string {
  const byRun = new Map<string, CiFinding[]>();
  for (const f of findings) {
    const key = `${f.checkRunName} (check run ${f.checkRunId})`;
    const group = byRun.get(key) ?? [];
    group.push(f);
    byRun.set(key, group);
  }

  const sections: string[] = [];
  for (const [header, group] of byRun) {
    const lines = group.map((f) => {
      const rule = f.rule ? ` (${f.rule})` : "";
      return `- ${f.file}:${f.line}: [${f.level}] ${f.message}${rule}`;
    });
    sections.push(`### ${header}\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}

export function buildCiFindingsPrompt(
  ctx: StageContext,
  opts: Pick<CiCheckStageOptions, "issueTitle" | "issueBody">,
  findings: CiFinding[],
  findingsIncomplete?: boolean,
): string {
  const lines = [
    `CI passed but check runs reported findings (annotations).`,
    `Review the findings below and decide whether any should be addressed.`,
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
    `## CI Findings`,
    ``,
    formatFindings(findings),
  ];

  if (findingsIncomplete) {
    lines.push(
      ``,
      `**Note:** Some check run annotations could not be fetched.`,
      `The findings above may be incomplete.  Check the PR's Checks`,
      `tab for the full list of annotations.`,
    );
  }

  lines.push(
    ``,
    `## Instructions`,
    ``,
    `For each finding, decide whether it should be fixed or can be`,
    `safely ignored.  If you fix any findings:`,
    ``,
    buildDocConsistencyInstructions(),
    ``,
    `${buildPrSyncInstructions(ctx.issueNumber)}`,
    ``,
    `Then commit and push the branch so a new CI run is triggered.`,
    `If all findings are acceptable as-is, explain your reasoning.`,
  );

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
  const readHeadSha = opts.getHeadSha ?? defaultGetHeadSha;
  const pollInterval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeout = opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const emptyGrace =
    opts.emptyRunsGracePeriodMs ?? DEFAULT_EMPTY_RUNS_GRACE_PERIOD_MS;
  const delay = opts.delay ?? defaultDelay;

  return {
    name: t()["stage.ciCheck"],
    number: 5,
    handler: async (ctx: StageContext): Promise<StageResult> => {
      // ---- poll for CI completion ------------------------------------------

      const startTime = Date.now();

      let ciStatus: CiStatus;
      while (true) {
        const commitSha = readHeadSha(ctx.worktreePath);

        try {
          ciStatus = getCiStatus(ctx.owner, ctx.repo, ctx.branch, commitSha);
        } catch (err) {
          // Transient lookup error — log and retry on the next poll cycle.
          console.warn(
            `CI status lookup failed (will retry): ${err instanceof Error ? err.message : err}`,
          );
          const elapsed = Date.now() - startTime;
          if (elapsed >= pollTimeout) {
            return {
              outcome: "error",
              message: t()["ci.pendingTimeout"](Math.round(pollTimeout / 1000)),
            };
          }
          await delay(pollInterval);
          continue;
        }

        const elapsed = Date.now() - startTime;

        if (ciStatus.verdict !== "pending") {
          // When SHA-filtering, an empty "pass" may mean the workflow
          // hasn't been created yet.  Keep polling within the grace
          // period; after that, accept it (no CI / skipped workflow).
          const withinGrace =
            ciStatus.runs.length === 0 && elapsed < emptyGrace;
          if (!withinGrace) break;
        }

        if (elapsed >= pollTimeout) {
          return {
            outcome: "error",
            message: t()["ci.pendingTimeout"](Math.round(pollTimeout / 1000)),
          };
        }

        await delay(pollInterval);
      }

      // ---- CI passed (clean) ------------------------------------------------

      if (
        ciStatus.verdict === "pass" &&
        ciStatus.findings.length === 0 &&
        !ciStatus.findingsIncomplete
      ) {
        return { outcome: "completed", message: t()["ci.passed"] };
      }

      // ---- CI passed with findings — present for review -------------------

      if (ciStatus.verdict === "pass") {
        const shaBeforeReview = readHeadSha(ctx.worktreePath);

        const findingsPrompt = buildCiFindingsPrompt(
          ctx,
          opts,
          ciStatus.findings,
          ciStatus.findingsIncomplete,
        );
        ctx.promptSinks?.a?.(findingsPrompt);
        const reviewResult = await invokeOrResume(
          opts.agent,
          ctx.savedAgentASessionId,
          findingsPrompt,
          ctx.worktreePath,
          ctx.streamSinks?.a,
          undefined,
          ctx.usageSinks?.a,
        );

        if (reviewResult.sessionId) {
          ctx.onSessionId?.("a", reviewResult.sessionId);
        }

        if (reviewResult.status === "error") {
          return mapAgentError(reviewResult, "during CI findings review");
        }

        const shaAfterReview = readHeadSha(ctx.worktreePath);
        if (shaBeforeReview !== shaAfterReview) {
          // Agent pushed changes — loop back to re-check CI.
          return {
            outcome: "not_approved",
            message: reviewResult.responseText,
          };
        }

        // Agent reviewed but did not push — findings acknowledged.
        return { outcome: "completed", message: t()["ci.passedWithFindings"] };
      }

      // ---- CI failed — collect logs and send to agent ----------------------

      const failedRuns = ciStatus.runs.filter((r) => {
        const conclusion = normaliseCiConclusion(r);
        return conclusion === "failure" || conclusion === "cancelled";
      });

      const logSections: string[] = [];
      for (const run of failedRuns) {
        const logs = collectLogs(ctx.owner, ctx.repo, run);
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
      ctx.promptSinks?.a?.(prompt);
      const fixResult = await invokeOrResume(
        opts.agent,
        ctx.savedAgentASessionId,
        prompt,
        ctx.worktreePath,
        ctx.streamSinks?.a,
        undefined,
        ctx.usageSinks?.a,
      );

      if (fixResult.sessionId) {
        ctx.onSessionId?.("a", fixResult.sessionId);
      }

      if (fixResult.status === "error") {
        return mapAgentError(fixResult, "during CI fix");
      }

      // Return not_approved so the engine loops back to poll CI again.
      return { outcome: "not_approved", message: fixResult.responseText };
    },
  };
}
