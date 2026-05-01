/**
 * Stage 5 — CI check loop.
 *
 * Polls CI status for the branch.  When CI is pending the handler waits
 * internally (without consuming the engine's auto-budget).  When CI
 * passes the stage completes.  When CI fails the handler collects
 * failure logs, sends them to the agent for a fix, and returns
 * `"not_approved"` so the engine loops back for another CI poll.
 *
 * The engine's auto-budget (configurable via `ciCheckAutoIterations`,
 * default 3) handles the fix iteration limit.  The poll timeout
 * (configurable via `ciCheckTimeoutMinutes`, default 10) caps how
 * long the stage waits for a pending CI run.
 */

import type { AgentAdapter } from "./agent.js";
import type {
  CiFinding,
  CiRun,
  CiStatus,
  CorrelatedFinding,
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
  /** Injected for testability. Defaults to `ci.fetchCodeScanningAlerts`. */
  fetchCodeScanningAlerts?: FetchCodeScanningAlertsFn;
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
 * Compact resume-form CI fix prompt — repository / issue context is
 * already in the live agent session, so only the failure logs and
 * instructions are re-sent.
 */
export function buildCiFixResumePrompt(
  ctx: StageContext,
  failureLogs: string,
): string {
  const lines = [
    `Fix the CI failures for issue #${ctx.issueNumber}.`,
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
 * findings-review prompt.  When correlated findings are available,
 * each finding includes its alert number for dismiss operations.
 */
function formatFindings(findings: CiFinding[]): string;
function formatFindings(correlated: CorrelatedFinding[]): string;
function formatFindings(items: CiFinding[] | CorrelatedFinding[]): string {
  // Normalise to CorrelatedFinding shape.
  const correlated: CorrelatedFinding[] = items.map((item) =>
    "finding" in item ? item : { finding: item },
  );

  const byRun = new Map<string, CorrelatedFinding[]>();
  for (const cf of correlated) {
    const f = cf.finding;
    const key = `${f.checkRunName} (check run ${f.checkRunId})`;
    const group = byRun.get(key) ?? [];
    group.push(cf);
    byRun.set(key, group);
  }

  const sections: string[] = [];
  for (const [header, group] of byRun) {
    const lines = group.map((cf) => {
      const f = cf.finding;
      const rule = f.rule ? ` (${f.rule})` : "";
      const alert = cf.alertNumber != null ? ` [alert #${cf.alertNumber}]` : "";
      return `- ${f.file}:${f.line}: [${f.level}] ${f.message}${rule}${alert}`;
    });
    sections.push(`### ${header}\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}

/**
 * Build triage criteria and dismiss instructions for CodeQL findings.
 * Only included when at least one finding is correlated to an alert.
 */
function buildTriageInstructions(
  ctx: StageContext,
  correlated: CorrelatedFinding[],
): string {
  const hasAlerts = correlated.some((cf) => cf.alertNumber != null);
  if (!hasAlerts) return "";

  const dismissible = correlated.filter((cf) => cf.alertNumber != null);

  const lines = [
    ``,
    `## CodeQL Triage`,
    ``,
    `For each finding marked with an alert number (\`[alert #N]\`), evaluate`,
    `whether it is a **real issue** or a **false positive**.`,
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
    `- The data is already sanitised or validated before it reaches the`,
    `  flagged location, but CodeQL cannot see through the sanitiser.`,
    `- The flagged code is dead, test-only, or unreachable in production.`,
    `- The "source" is not actually attacker-controlled (e.g. a hardcoded`,
    `  constant, an environment variable set at deploy time).`,
    `- The framework or library provides built-in protection that makes`,
    `  the flagged pattern safe (e.g. parameterised queries).`,
    ``,
    `### Actions`,
    ``,
    `- **Real issue:** Fix the code.  After fixing, commit and push.`,
    `- **False positive:** For each false-positive alert, run these`,
    `  commands (one pair per alert):`,
    ``,
    `  \`\`\``,
    `  gh api -X PATCH "repos/${ctx.owner}/${ctx.repo}/code-scanning/alerts/{number}" \\`,
    `    -f state=dismissed \\`,
    `    -f "dismissed_reason=false positive" \\`,
    `    -f "dismissed_comment={your brief explanation}"`,
    `  \`\`\``,
    ``,
    `  Then leave one PR comment summarising all dismissed alerts and`,
    `  the reasoning for each.  First, find the PR number:`,
    ``,
    `  \`\`\``,
    `  gh pr view --repo ${ctx.owner}/${ctx.repo} ${ctx.branch} --json number --jq .number`,
    `  \`\`\``,
    ``,
    `  Then post the comment:`,
    ``,
    `  \`\`\``,
    `  gh pr comment --repo ${ctx.owner}/${ctx.repo} <pr_number> --body "..."`,
    `  \`\`\``,
    ``,
    `### Dismissible alerts`,
    ``,
  ];

  for (const cf of dismissible) {
    const f = cf.finding;
    const rule = f.rule ?? "(unknown rule)";
    lines.push(`- Alert #${cf.alertNumber}: ${rule} at ${f.file}:${f.line}`);
  }

  return lines.join("\n");
}

export function buildCiFindingsPrompt(
  ctx: StageContext,
  opts: Pick<CiCheckStageOptions, "issueTitle" | "issueBody">,
  findings: CiFinding[],
  findingsIncomplete?: boolean,
  correlated?: CorrelatedFinding[],
): string {
  const lines = [
    `CI passed but check runs reported findings (annotations).`,
    `Review the findings below and decide whether any should be addressed.`,
    ``,
    `## Issue #${ctx.issueNumber}: ${opts.issueTitle}`,
    ``,
    opts.issueBody,
    ``,
    `## CI Findings`,
    ``,
    correlated ? formatFindings(correlated) : formatFindings(findings),
  ];

  if (findingsIncomplete) {
    lines.push(
      ``,
      `**Note:** Some check run annotations could not be fetched.`,
      `The findings above may be incomplete.  Check the PR's Checks`,
      `tab for the full list of annotations.`,
    );
  }

  if (correlated) {
    lines.push(buildTriageInstructions(ctx, correlated));
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

/**
 * Compact resume-form findings prompt — drops the issue body which
 * the agent's live session already has from prior stages.  Findings
 * data and the (conditional) CodeQL triage block are preserved
 * because they are dynamic per-run content.
 */
export function buildCiFindingsResumePrompt(
  ctx: StageContext,
  findings: CiFinding[],
  findingsIncomplete?: boolean,
  correlated?: CorrelatedFinding[],
): string {
  const lines = [
    `CI passed but check runs reported findings (annotations) for issue`,
    `#${ctx.issueNumber}.  Review the findings below and decide whether`,
    `any should be addressed.`,
    ``,
    `## CI Findings`,
    ``,
    correlated ? formatFindings(correlated) : formatFindings(findings),
  ];

  if (findingsIncomplete) {
    lines.push(
      ``,
      `**Note:** Some check run annotations could not be fetched.`,
      `The findings above may be incomplete.  Check the PR's Checks`,
      `tab for the full list of annotations.`,
    );
  }

  if (correlated) {
    lines.push(buildTriageInstructions(ctx, correlated));
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
  const fetchAlerts = opts.fetchCodeScanningAlerts ?? defaultFetchAlerts;
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

        // Fetch code scanning alerts and correlate to findings so
        // the agent can dismiss false positives by alert number.
        const alerts = fetchAlerts(ctx.owner, ctx.repo, ctx.branch);
        const correlated =
          alerts.length > 0
            ? correlateFindings(ciStatus.findings, alerts)
            : undefined;

        const freshFindingsPrompt = buildCiFindingsPrompt(
          ctx,
          opts,
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

      const freshFixPrompt = buildCiFixPrompt(ctx, opts, failureLogs);
      const resumeFixPrompt = buildCiFixResumePrompt(ctx, failureLogs);
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
