/**
 * Stage 5 — CI check loop.
 *
 * Polls CI status for the branch.  When CI is pending the handler waits
 * internally (without consuming the engine's auto-budget).  When CI
 * passes the stage completes.  When CI fails the handler builds a
 * bounded {@link CiInspectionContext} (pointers to the failing runs
 * and jobs) and sends it to the agent for a fix; the agent then
 * fetches logs, annotations, and code scanning alerts itself with
 * `gh`.  The handler returns `"not_approved"` so the engine loops
 * back for another CI poll.
 *
 * The engine's auto-budget (configurable via `ciCheckAutoIterations`,
 * default 3) handles the fix iteration limit.  The poll timeout
 * (configurable via `ciCheckTimeoutMinutes`, default 10) caps how
 * long the stage waits for a pending CI run.
 */

import type { AgentAdapter } from "./agent.js";
import type {
  BuildCiInspectionContextFn,
  CiInspectionContext,
  CiStatus,
  GetCiStatusFn,
} from "./ci.js";
import {
  buildCiInspectionContext as defaultBuildCiInspectionContext,
  getCiStatus as defaultGetCiStatus,
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
  /**
   * Read the current HEAD SHA from the worktree.  Called before each
   * CI poll so that fix pushes automatically target the new commit.
   * Injected for testability.  Defaults to `worktree.getHeadSha`.
   */
  getHeadSha?: (cwd: string) => string;
  /**
   * Injected for testability.  Defaults to `ci.buildCiInspectionContext`.
   * Used to derive bounded pointer metadata about the failing CI
   * surfaces so the agent can fetch the actual logs/annotations/alerts
   * itself with `gh`.
   */
  buildCiInspectionContext?: BuildCiInspectionContextFn;
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

// ---- prompt body helpers ---------------------------------------------------

function formatInspectionContext(inspection: CiInspectionContext): string {
  const lines: string[] = [];
  lines.push(`ref: ${inspection.ref}`);
  lines.push(`hasAnnotations: ${inspection.hasAnnotations}`);
  lines.push(`annotationsIncomplete: ${inspection.annotationsIncomplete}`);

  if (inspection.workflowRuns.length > 0) {
    lines.push(``, `Failing workflow runs:`);
    for (const wr of inspection.workflowRuns) {
      lines.push(`- runId: ${wr.runId}`);
      if (wr.failedJobs.length === 0) {
        lines.push(`  failedJobs: (unable to enumerate — fetch via gh)`);
      } else {
        lines.push(`  failedJobs:`);
        for (const job of wr.failedJobs) {
          lines.push(`    - ${job.id} ${JSON.stringify(job.name)}`);
        }
      }
    }
  } else {
    lines.push(``, `Failing workflow runs: (none)`);
  }

  if (inspection.checkRunIds.length > 0) {
    lines.push(``, `Check runs to inspect:`);
    for (const id of inspection.checkRunIds) {
      lines.push(`- ${id}`);
    }
  } else {
    lines.push(``, `Check runs to inspect: (none)`);
  }

  return lines.join("\n");
}

function buildFetchHints(
  ctx: StageContext,
  inspection: CiInspectionContext,
): string {
  const repo = `${ctx.owner}/${ctx.repo}`;
  const ref = inspection.ref;
  const lines = [
    `## Fetching CI details`,
    ``,
    `Failure logs, annotation bodies, and code scanning alert payloads`,
    `are **not** inlined here — fetch them yourself with \`gh\` as you`,
    `narrow down the failure.  Useful commands:`,
    ``,
    "```",
    `# Failure logs for a specific job in a workflow run (preferred —`,
    `# scopes the log to one job rather than the entire workflow):`,
    `gh run view <runId> --repo ${repo} --log-failed --job <jobId>`,
    ``,
    `# Whole-run failure log (use only when no job IDs are listed):`,
    `gh run view <runId> --repo ${repo} --log-failed`,
    ``,
    `# Check run output and annotations:`,
    `gh api "repos/${repo}/check-runs/<checkRunId>"`,
    `gh api "repos/${repo}/check-runs/<checkRunId>/annotations"`,
    ``,
    `# Open code scanning alerts for the ref:`,
    `gh api "repos/${repo}/code-scanning/alerts?ref=${ref}&state=open&per_page=100"`,
    "```",
  ];
  if (inspection.annotationsIncomplete) {
    lines.push(
      ``,
      `**Note:** \`annotationsIncomplete\` is true — the inspection`,
      `metadata above may be partial.  Any of the following could be`,
      `truncated: the failing-jobs listing for a workflow run, the`,
      `workflow-run list itself, or the check-runs listing for the`,
      `ref (so additional check-run IDs may exist beyond those above).`,
      `Paginate the relevant listing yourself before drawing`,
      `conclusions:`,
      ``,
      "```",
      `# Failing jobs for a workflow run (per_page caps at 100):`,
      `gh api "repos/${repo}/actions/runs/<runId>/jobs?per_page=100&page=<n>"`,
      ``,
      `# Workflow runs for the branch:`,
      `gh run list --repo ${repo} --branch ${ctx.branch} --limit 100`,
      ``,
      `# Check runs for the ref (additional IDs may live on later pages):`,
      `gh api "repos/${repo}/commits/${ref}/check-runs?per_page=100&page=<n>"`,
      "```",
    );
  }
  return lines.join("\n");
}

function buildDismissAlertsBlock(ctx: StageContext): string {
  const repo = `${ctx.owner}/${ctx.repo}`;
  return [
    `## Triage of code scanning alerts`,
    ``,
    `Some annotations may correspond to open code scanning alerts.`,
    `Fetch the alerts list for the ref above, then for each alert`,
    `decide whether it is a **real issue** or a **false positive**.`,
    ``,
    `### Evaluation criteria`,
    ``,
    `A finding is a **real issue** when:`,
    `- The flagged code path is reachable in production.`,
    `- An attacker-controlled or untrusted input can reach the sink`,
    `  without adequate sanitisation or validation.`,
    `- The reported weakness (e.g. SQL injection, XSS, path traversal)`,
    `  is exploitable given the application's threat model.`,
    ``,
    `A finding is a **false positive** when:`,
    `- The data is already sanitised or validated before it reaches`,
    `  the flagged location, but the analyser cannot see through the`,
    `  sanitiser.`,
    `- The flagged code is dead, test-only, or unreachable in`,
    `  production.`,
    `- The "source" is not actually attacker-controlled (e.g. a`,
    `  hardcoded constant, an environment variable set at deploy time).`,
    `- The framework or library provides built-in protection that`,
    `  makes the flagged pattern safe (e.g. parameterised queries).`,
    ``,
    `### Actions`,
    ``,
    `- **Real issue:** Fix the code.  After fixing, commit and push.`,
    `- **False positive:** For each false-positive alert, dismiss it`,
    `  via the API:`,
    ``,
    "```",
    `gh api -X PATCH "repos/${repo}/code-scanning/alerts/{number}" \\`,
    `  -f state=dismissed \\`,
    `  -f "dismissed_reason=false positive" \\`,
    `  -f "dismissed_comment={your brief explanation}"`,
    "```",
    ``,
    `  Then leave one PR comment summarising all dismissed alerts and`,
    `  the reasoning for each.  First, find the PR number:`,
    ``,
    "```",
    `gh pr view --repo ${repo} ${ctx.branch} --json number --jq .number`,
    "```",
    ``,
    `  Then post the comment:`,
    ``,
    "```",
    `gh pr comment --repo ${repo} <pr_number> --body "..."`,
    "```",
  ].join("\n");
}

// ---- prompt builders -------------------------------------------------------

export function buildCiFixPrompt(
  ctx: StageContext,
  opts: Pick<CiCheckStageOptions, "issueTitle" | "issueBody">,
  inspection: CiInspectionContext,
): string {
  const lines = [
    `You are fixing CI failures for the following GitHub issue.`,
    ``,
    `## Issue #${ctx.issueNumber}: ${opts.issueTitle}`,
    ``,
    opts.issueBody,
    ``,
    `## CI Inspection Context`,
    ``,
    `Repository: ${ctx.owner}/${ctx.repo}`,
    `Branch: ${ctx.branch}`,
    formatInspectionContext(inspection),
    ``,
    buildFetchHints(ctx, inspection),
    ``,
    `## Instructions`,
    ``,
    `Use the pointers above and the \`gh\` commands to read the actual`,
    `failure context, diagnose the failures, and fix them.  After`,
    `making your changes:`,
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
 * Compact resume-form CI fix prompt — repository / issue context is
 * already in the live agent session, so only the inspection context
 * and instructions are re-sent.
 */
export function buildCiFixResumePrompt(
  ctx: StageContext,
  inspection: CiInspectionContext,
): string {
  const lines = [
    `Fix the CI failures for issue #${ctx.issueNumber}.`,
    ``,
    `## CI Inspection Context`,
    ``,
    `Repository: ${ctx.owner}/${ctx.repo}`,
    `Branch: ${ctx.branch}`,
    formatInspectionContext(inspection),
    ``,
    buildFetchHints(ctx, inspection),
    ``,
    `## Instructions`,
    ``,
    `Use the pointers above and the \`gh\` commands to read the actual`,
    `failure context, diagnose the failures, and fix them.  After`,
    `making your changes:`,
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

export function buildCiFindingsPrompt(
  ctx: StageContext,
  opts: Pick<CiCheckStageOptions, "issueTitle" | "issueBody">,
  inspection: CiInspectionContext,
): string {
  const lines = [
    `CI passed but check runs reported annotations.  Inspect them`,
    `yourself and decide whether any should be addressed.`,
    ``,
    `## Issue #${ctx.issueNumber}: ${opts.issueTitle}`,
    ``,
    opts.issueBody,
    ``,
    `## CI Inspection Context`,
    ``,
    `Repository: ${ctx.owner}/${ctx.repo}`,
    `Branch: ${ctx.branch}`,
    formatInspectionContext(inspection),
    ``,
    buildFetchHints(ctx, inspection),
    ``,
    buildDismissAlertsBlock(ctx),
    ``,
    `## Instructions`,
    ``,
    `Read the annotations and any code scanning alerts via the \`gh\``,
    `commands above.  For each finding, decide whether it should be`,
    `fixed or can be safely ignored.  If you fix any findings:`,
    ``,
    buildDocConsistencyInstructions(),
    ``,
    `${buildPrSyncInstructions(ctx.issueNumber)}`,
    ``,
    `Then commit and push the branch so a new CI run is triggered.`,
    `If all findings are acceptable as-is, explain your reasoning.`,
  ];

  if (ctx.userInstruction) {
    lines.push(``, `## Additional feedback`, ``, ctx.userInstruction);
  }

  return lines.join("\n");
}

/**
 * Compact resume-form findings prompt — drops the issue body which
 * the agent's live session already has from prior stages.  The
 * pointer metadata is preserved because it is dynamic per-run.
 */
export function buildCiFindingsResumePrompt(
  ctx: StageContext,
  inspection: CiInspectionContext,
): string {
  const lines = [
    `CI passed but check runs reported annotations for issue`,
    `#${ctx.issueNumber}.  Inspect them yourself and decide whether`,
    `any should be addressed.`,
    ``,
    `## CI Inspection Context`,
    ``,
    `Repository: ${ctx.owner}/${ctx.repo}`,
    `Branch: ${ctx.branch}`,
    formatInspectionContext(inspection),
    ``,
    buildFetchHints(ctx, inspection),
    ``,
    buildDismissAlertsBlock(ctx),
    ``,
    `## Instructions`,
    ``,
    `Read the annotations and any code scanning alerts via the \`gh\``,
    `commands above.  For each finding, decide whether it should be`,
    `fixed or can be safely ignored.  If you fix any findings:`,
    ``,
    buildDocConsistencyInstructions(),
    ``,
    `${buildPrSyncInstructions(ctx.issueNumber)}`,
    ``,
    `Then commit and push the branch so a new CI run is triggered.`,
    `If all findings are acceptable as-is, explain your reasoning.`,
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
  const buildInspection =
    opts.buildCiInspectionContext ?? defaultBuildCiInspectionContext;
  const readHeadSha = opts.getHeadSha ?? defaultGetHeadSha;
  const pollInterval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeout = opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const emptyGrace =
    opts.emptyRunsGracePeriodMs ?? DEFAULT_EMPTY_RUNS_GRACE_PERIOD_MS;
  const delay = opts.delay ?? defaultDelay;

  return {
    name: t()["stage.ciCheck"],
    number: 5,
    primaryAgent: "a",
    handler: async (ctx: StageContext): Promise<StageResult> => {
      // ---- poll for CI completion ------------------------------------------

      const startTime = Date.now();

      let ciStatus: CiStatus;
      let commitSha: string | undefined;
      while (true) {
        commitSha = readHeadSha(ctx.worktreePath);

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

      const ref = commitSha ?? ctx.branch;

      // ---- CI passed ------------------------------------------------------

      if (ciStatus.verdict === "pass") {
        // Determine whether any check run reports annotations; if not,
        // it's a clean pass.  We avoid building the full inspection
        // context (which fetches per-run job listings) until we know
        // we'll use it.
        //
        // If the CI run listing itself was truncated (e.g. >100 check
        // runs on the commit), annotations on later pages would be
        // invisible here — treat that as "annotations may exist" so
        // the agent gets a chance to paginate, instead of declaring
        // a clean pass on incomplete data.
        const hasAnnotations =
          ciStatus.runsIncomplete === true ||
          ciStatus.runs.some(
            (r) =>
              r.source === "check" &&
              r.annotationsCount != null &&
              r.annotationsCount > 0,
          );
        if (!hasAnnotations) {
          return { outcome: "completed", message: t()["ci.passed"] };
        }

        // ---- CI passed with annotations — present pointers for review ----

        const inspection = buildInspection(ctx.owner, ctx.repo, ref, ciStatus);
        const shaBeforeReview = readHeadSha(ctx.worktreePath);

        const freshFindingsPrompt = buildCiFindingsPrompt(
          ctx,
          opts,
          inspection,
        );
        const resumeFindingsPrompt = buildCiFindingsResumePrompt(
          ctx,
          inspection,
        );
        const findingsUseResume = ctx.savedAgentASessionId !== undefined;
        const findingsPrompt = findingsUseResume
          ? resumeFindingsPrompt
          : freshFindingsPrompt;
        ctx.promptSinks?.a?.(findingsPrompt, "ci-fix");
        const reviewResult = await invokeOrResume(
          opts.agent,
          ctx.savedAgentASessionId,
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

      // ---- CI failed — build pointer context and send to agent ------------

      const inspection = buildInspection(ctx.owner, ctx.repo, ref, ciStatus);

      const freshFixPrompt = buildCiFixPrompt(ctx, opts, inspection);
      const resumeFixPrompt = buildCiFixResumePrompt(ctx, inspection);
      const fixUseResume = ctx.savedAgentASessionId !== undefined;
      const prompt = fixUseResume ? resumeFixPrompt : freshFixPrompt;
      ctx.promptSinks?.a?.(prompt, "ci-fix");
      const fixResult = await invokeOrResume(
        opts.agent,
        ctx.savedAgentASessionId,
        prompt,
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
