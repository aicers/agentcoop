/**
 * CI status polling and failure log collection.
 *
 * Wraps `gh run list` and `gh run view` to determine whether CI checks
 * pass for a given branch/commit.  Reusable by stages 5, 7, and 8.
 */

import { ghExec } from "./gh-exec.js";

// ---- public types --------------------------------------------------------

export type CheckConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "pending"
  | "neutral";

export type CiRunSource = "workflow" | "check";

export interface CiRun {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string;
  headBranch: string;
  headSha: string;
  source: CiRunSource;
  /** Populated for check runs from the list endpoint; avoids a re-fetch. */
  checkOutput?: {
    title: string | null;
    summary: string | null;
    text: string | null;
  };
  /** Populated for check runs from the list endpoint; avoids a re-fetch. */
  annotationsCount?: number;
}

export type CiVerdict = "pass" | "fail" | "pending";

/** A single annotation-level finding from a check run. */
export interface CiFinding {
  /** Annotation level: "notice", "warning", or "failure". */
  level: string;
  /** Human-readable message from the annotation. */
  message: string;
  /** File path relative to the repository root. */
  file: string;
  /** Start line in the file. */
  line: number;
  /** Optional annotation title (often a rule ID). */
  rule?: string;
  /** Database ID of the check run that produced this finding. */
  checkRunId: number;
  /** Name of the check run that produced this finding. */
  checkRunName: string;
  /** Commit SHA of the check run that produced this finding. */
  commitSha: string;
}

export interface CiStatus {
  verdict: CiVerdict;
  /** Individual check runs used to compute the verdict. */
  runs: CiRun[];
}

/**
 * Signature shared by `getCiStatus` and all injectable overrides.
 * Extracted to avoid repeating the 4-param signature across every
 * stage options interface.
 */
export type GetCiStatusFn = (
  owner: string,
  repo: string,
  branch: string,
  commitSha?: string,
) => CiStatus;

// ---- CI pass criteria ----------------------------------------------------

/**
 * Evaluate a set of CI runs against the pass criteria:
 *
 * - `success` / `neutral` / `skipped` → pass
 * - `pending` (status = "in_progress" | "queued" | "waiting") → pending
 * - `cancelled` → failure
 * - `failure` → failure
 *
 * Overall verdict:
 * - If **any** run is `failure` or `cancelled` → `"fail"`
 * - Else if **any** run is `pending` → `"pending"`
 * - Otherwise → `"pass"`
 */
export function evaluateCiRuns(runs: CiRun[]): CiVerdict {
  let hasPending = false;

  for (const run of runs) {
    const conclusion = normaliseCiConclusion(run);

    if (conclusion === "failure" || conclusion === "cancelled") {
      return "fail";
    }
    if (conclusion === "pending") {
      hasPending = true;
    }
  }

  return hasPending ? "pending" : "pass";
}

/**
 * Derive a normalised conclusion from a run's status and conclusion
 * fields.  GitHub's API uses `status` for in-flight runs and
 * `conclusion` once finished.
 */
export function normaliseCiConclusion(run: CiRun): CheckConclusion {
  const status = (run.status ?? "").toLowerCase();
  if (
    status === "in_progress" ||
    status === "queued" ||
    status === "waiting" ||
    status === "pending" ||
    status === "requested"
  ) {
    return "pending";
  }

  const conclusion = (run.conclusion ?? "").toLowerCase();
  if (conclusion === "success" || conclusion === "neutral") return "success";
  if (conclusion === "skipped") return "skipped";
  if (conclusion === "cancelled") return "cancelled";
  // Empty conclusion with a completed status means something went wrong.
  return "failure";
}

// ---- internal types for Checks API ----------------------------------------

interface CheckRunApiEntry {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  output: {
    title: string | null;
    summary: string | null;
    text: string | null;
  };
  annotations_count: number;
  app?: { slug?: string };
}

interface CheckRunAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: string;
  message: string;
  title?: string;
}

// ---- annotation collection -----------------------------------------------

/**
 * Fetch annotations for a single check run from the GitHub Checks API.
 * Paginates automatically to collect all pages.
 */
function fetchCheckRunAnnotations(
  owner: string,
  repo: string,
  checkRunId: number,
): CheckRunAnnotation[] {
  const raw = ghExec([
    "api",
    "--paginate",
    "--slurp",
    `repos/${owner}/${repo}/check-runs/${checkRunId}/annotations?per_page=100`,
  ]);
  const pages: CheckRunAnnotation[][] = JSON.parse(raw);
  return pages.flat();
}

/**
 * Collect annotation-level findings from a set of CI runs.
 *
 * Only check runs (source = "check") with a non-zero annotation count
 * are inspected.  Returns an empty array when no annotations exist.
 */
export function collectFindings(
  owner: string,
  repo: string,
  runs: CiRun[],
): { findings: CiFinding[]; incomplete: boolean } {
  const findings: CiFinding[] = [];
  let incomplete = false;

  for (const run of runs) {
    if (
      run.source !== "check" ||
      run.annotationsCount == null ||
      run.annotationsCount === 0
    ) {
      continue;
    }

    let annotations: CheckRunAnnotation[];
    try {
      annotations = fetchCheckRunAnnotations(owner, repo, run.databaseId);
    } catch {
      // Annotation fetch failed — flag as incomplete so callers
      // do not treat an empty findings list as a clean pass.
      incomplete = true;
      continue;
    }

    for (const a of annotations) {
      findings.push({
        level: a.annotation_level,
        message: a.message,
        file: a.path,
        line: a.start_line,
        rule: a.title,
        checkRunId: run.databaseId,
        checkRunName: run.name,
        commitSha: run.headSha,
      });
    }
  }

  return { findings, incomplete };
}

// ---- gh CLI wrappers -----------------------------------------------------

/**
 * Fetch check runs from the GitHub Checks API for a given ref.
 * Filters out check runs created by GitHub Actions (already covered
 * by `gh run list`).
 */
function fetchCheckRunsFromApi(
  owner: string,
  repo: string,
  ref: string,
): CiRun[] {
  const output = ghExec([
    "api",
    `repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
  ]);

  const parsed = JSON.parse(output);
  const entries: CheckRunApiEntry[] = parsed.check_runs ?? [];

  // Exclude check runs created by GitHub Actions — those are already
  // covered by the workflow run list.
  return entries
    .filter((entry) => entry.app?.slug !== "github-actions")
    .map((entry) => ({
      databaseId: entry.id,
      name: entry.name,
      status: entry.status,
      conclusion: entry.conclusion ?? "",
      headBranch: "",
      headSha: entry.head_sha,
      source: "check" as const,
      checkOutput: entry.output,
      annotationsCount: entry.annotations_count,
    }));
}

/**
 * Collect failure context for a check run by fetching its output
 * and annotations from the Checks API.
 *
 * When the parent `CiRun` already carries `checkOutput` and
 * `annotationsCount` (populated from the list endpoint), the
 * detail re-fetch is skipped to avoid a redundant API call.
 */
function collectCheckRunLogs(owner: string, repo: string, run: CiRun): string {
  const sections: string[] = [];
  const checkRunId = run.databaseId;

  // Use carried-forward data when available; otherwise re-fetch.
  let output = run.checkOutput;
  let annotationsCount = run.annotationsCount;

  if (output === undefined) {
    let detail: CheckRunApiEntry | undefined;
    try {
      const raw = ghExec([
        "api",
        `repos/${owner}/${repo}/check-runs/${checkRunId}`,
      ]);
      detail = JSON.parse(raw);
    } catch {
      return "Unable to retrieve check run details.";
    }
    output = detail?.output;
    annotationsCount = detail?.annotations_count;
  }

  if (output) {
    const { title, summary, text } = output;
    if (title) sections.push(`Title: ${title}`);
    if (summary) sections.push(`Summary: ${summary}`);
    if (text) sections.push(`Details: ${text}`);
  }

  // Fetch annotations when present via the shared helper.
  if (annotationsCount != null && annotationsCount > 0) {
    try {
      const annotations = fetchCheckRunAnnotations(owner, repo, checkRunId);
      if (annotations.length > 0) {
        const lines = annotations.map(
          (a) =>
            `  ${a.path}:${a.start_line}: [${a.annotation_level}] ${a.message}`,
        );
        sections.push(`Annotations:\n${lines.join("\n")}`);
      }
    } catch {
      // Annotations fetch failed; output-only context is still useful.
    }
  }

  return sections.length > 0
    ? sections.join("\n\n")
    : "No detailed check run output available.";
}

/**
 * Fetch the latest CI runs for `branch` in `owner/repo`.
 *
 * Queries both GitHub Actions workflow runs (`gh run list`) and
 * Checks API check runs.  Check runs from GitHub Actions are
 * excluded to avoid double-counting.
 *
 * When `commitSha` is provided, uses `gh run list --commit` and
 * `commits/{sha}/check-runs` to filter by SHA.
 */
export function fetchCiRuns(
  owner: string,
  repo: string,
  branch: string,
  commitSha?: string,
): CiRun[] {
  // ---- workflow runs via gh CLI -------------------------------------------
  const args = [
    "run",
    "list",
    "--repo",
    `${owner}/${repo}`,
    "--branch",
    branch,
    "--json",
    "databaseId,name,status,conclusion,headBranch,headSha",
    "--limit",
    "100",
  ];
  if (commitSha) {
    args.push("--commit", commitSha);
  }
  const output = ghExec(args);
  let workflowRuns: CiRun[];
  try {
    workflowRuns = (JSON.parse(output) as Omit<CiRun, "source">[]).map((r) => ({
      ...r,
      source: "workflow" as const,
    }));
  } catch {
    workflowRuns = [];
  }

  // ---- check runs via Checks API ------------------------------------------
  const ref = commitSha ?? branch;
  const checkRuns = fetchCheckRunsFromApi(owner, repo, ref);

  return [...workflowRuns, ...checkRuns];
}

/**
 * Fetch CI status for a branch, returning the overall verdict.
 *
 * When `commitSha` is provided, only runs triggered by that commit
 * are considered.
 *
 * Annotation findings, code scanning alerts, and raw failure logs are
 * deliberately *not* collected here — those are pointer-fetched by
 * the agent on demand (see {@link buildCiInspectionContext}) so the
 * pipeline does not pay the cost of unbounded API responses.
 */
export function getCiStatus(
  owner: string,
  repo: string,
  branch: string,
  commitSha?: string,
): CiStatus {
  const runs = fetchCiRuns(owner, repo, branch, commitSha);
  const verdict = evaluateCiRuns(runs);
  return { verdict, runs };
}

// ---- bounded inspection context (pointers only) --------------------------

/** A failed job within a workflow run, as referenced by the agent. */
export interface WorkflowFailedJob {
  id: number;
  name: string;
}

/** A failing or cancelled workflow run with the IDs of its failed jobs. */
export interface WorkflowRunInspection {
  runId: number;
  failedJobs: WorkflowFailedJob[];
}

/**
 * Bounded, pointer-only metadata describing the CI surfaces the agent
 * should inspect itself (failure logs, annotations, code scanning
 * alerts).  Replaces the previous habit of pre-fetching that content
 * and inlining it into prompts, which routinely overflowed the LLM
 * context window on large logs.
 *
 * This shape is what stages pass to prompt builders.  It must remain
 * small and constant-bounded regardless of CI volume — only IDs,
 * counts, and a ref live here.
 */
export interface CiInspectionContext {
  /** Failing or cancelled workflow runs and the IDs of their failed jobs. */
  workflowRuns: WorkflowRunInspection[];
  /** Database IDs of check runs the agent should consult. */
  checkRunIds: number[];
  /**
   * True when at least one check run reports a non-zero annotation
   * count.  Hint to the agent that there *may* be annotations to
   * read; the agent fetches them itself.
   */
  hasAnnotations: boolean;
  /**
   * True when the inspection metadata itself could not be fully
   * determined: a `gh api .../jobs` call failed, the jobs page hit
   * its size cap (potential truncation), or another listing was only
   * partially obtained.  Indicates the **pointers** are incomplete,
   * not the contents.  The agent uses this to decide whether to
   * retry the metadata read or proceed cautiously.
   */
  annotationsIncomplete: boolean;
  /**
   * Ref to use for code scanning alert queries — the commit SHA when
   * known, otherwise the branch name.
   */
  ref: string;
}

/** Signature shared by `buildCiInspectionContext` and injectable overrides. */
export type BuildCiInspectionContextFn = (
  owner: string,
  repo: string,
  ref: string,
  ciStatus: CiStatus,
) => CiInspectionContext;

/** Bounded cap for the failed-jobs listing per workflow run. */
const FAILED_JOBS_PAGE_LIMIT = 100;

interface WorkflowJobApiEntry {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

interface WorkflowJobsApiResponse {
  jobs?: WorkflowJobApiEntry[];
  total_count?: number;
}

function fetchFailedJobs(
  owner: string,
  repo: string,
  runId: number,
): { failedJobs: WorkflowFailedJob[]; truncated: boolean } | undefined {
  let raw: string;
  try {
    raw = ghExec([
      "api",
      `repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=${FAILED_JOBS_PAGE_LIMIT}`,
    ]);
  } catch {
    return undefined;
  }
  let parsed: WorkflowJobsApiResponse;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const jobs = parsed.jobs ?? [];
  const failedJobs: WorkflowFailedJob[] = [];
  for (const j of jobs) {
    const conclusion = (j.conclusion ?? "").toLowerCase();
    if (
      conclusion === "failure" ||
      conclusion === "cancelled" ||
      conclusion === "timed_out"
    ) {
      failedJobs.push({ id: j.id, name: j.name });
    }
  }
  const totalCount = parsed.total_count ?? jobs.length;
  const truncated =
    totalCount > FAILED_JOBS_PAGE_LIMIT ||
    jobs.length >= FAILED_JOBS_PAGE_LIMIT;
  return { failedJobs, truncated };
}

/**
 * Build a small, bounded inspection context that points the agent at
 * the failing CI surfaces (workflow runs/jobs, check runs, the ref
 * for code scanning queries).  The agent uses the pointers to fetch
 * logs, annotations, and alerts itself rather than receiving them
 * inlined in the prompt.
 *
 * **Contract for future edits:** this helper must NOT pull raw step
 * logs, raw alert payloads, or annotation bodies — those are exactly
 * what we are delegating to the agent because they grow unbounded.
 * Only bounded metadata (failing job IDs, check-run IDs, counts,
 * boolean flags) belongs here.  For matrix builds with many jobs,
 * only the first page (`per_page=100`) is read and
 * `annotationsIncomplete` is set so the agent knows to paginate
 * itself if needed.
 */
export function buildCiInspectionContext(
  owner: string,
  repo: string,
  ref: string,
  ciStatus: CiStatus,
): CiInspectionContext {
  const workflowRuns: WorkflowRunInspection[] = [];
  const checkRunIds: number[] = [];
  let hasAnnotations = false;
  let annotationsIncomplete = false;

  for (const run of ciStatus.runs) {
    const conclusion = normaliseCiConclusion(run);

    if (run.source === "workflow") {
      if (conclusion !== "failure" && conclusion !== "cancelled") {
        continue;
      }
      const fetched = fetchFailedJobs(owner, repo, run.databaseId);
      if (fetched === undefined) {
        annotationsIncomplete = true;
        workflowRuns.push({ runId: run.databaseId, failedJobs: [] });
      } else {
        if (fetched.truncated) annotationsIncomplete = true;
        workflowRuns.push({
          runId: run.databaseId,
          failedJobs: fetched.failedJobs,
        });
      }
      continue;
    }

    // source === "check"
    const annotated = run.annotationsCount != null && run.annotationsCount > 0;
    if (annotated) hasAnnotations = true;

    if (conclusion === "failure" || conclusion === "cancelled" || annotated) {
      checkRunIds.push(run.databaseId);
    }
  }

  return {
    workflowRuns,
    checkRunIds,
    hasAnnotations,
    annotationsIncomplete,
    ref,
  };
}

/**
 * Collect failure logs for a CI run.
 *
 * For workflow runs, uses `gh run view --log-failed`.
 * For check runs, fetches output and annotations from the Checks API.
 */
export function collectFailureLogs(
  owner: string,
  repo: string,
  run: CiRun,
): string {
  if (run.source === "check") {
    return collectCheckRunLogs(owner, repo, run);
  }
  const output = ghExec([
    "run",
    "view",
    String(run.databaseId),
    "--repo",
    `${owner}/${repo}`,
    "--log-failed",
  ]);
  return typeof output === "string" ? output : "";
}

// ---- code scanning alerts (CodeQL) ----------------------------------------

/** A code scanning alert from the GitHub Code Scanning API. */
export interface CodeScanningAlert {
  number: number;
  rule: { id: string };
  tool: { name: string };
  most_recent_instance: {
    location: {
      path: string;
      start_line: number;
    };
    commit_sha: string;
  };
  state: string;
  html_url: string;
}

/**
 * Signature shared by `fetchCodeScanningAlerts` and injectable overrides.
 */
export type FetchCodeScanningAlertsFn = (
  owner: string,
  repo: string,
  ref: string,
) => CodeScanningAlert[];

/**
 * Signature shared by `dismissCodeScanningAlert` and injectable overrides.
 */
export type DismissCodeScanningAlertFn = (
  owner: string,
  repo: string,
  alertNumber: number,
  reason: string,
) => void;

/**
 * Fetch open code scanning alerts for a given ref from the GitHub
 * Code Scanning API.  Returns an empty array when the API returns
 * a 404 (code scanning not enabled) or other error.
 */
export function fetchCodeScanningAlerts(
  owner: string,
  repo: string,
  ref: string,
): CodeScanningAlert[] {
  try {
    const raw = ghExec([
      "api",
      "--paginate",
      "--slurp",
      `repos/${owner}/${repo}/code-scanning/alerts?ref=${encodeURIComponent(ref)}&state=open&per_page=100`,
    ]);
    const pages: CodeScanningAlert[][] = JSON.parse(raw);
    return pages.flat();
  } catch {
    // Code scanning may not be enabled on the repo, or the ref
    // may not exist yet.  Return empty so callers degrade
    // gracefully to the non-triage prompt.
    return [];
  }
}

/** Result of correlating a CiFinding to a code scanning alert. */
export interface CorrelatedFinding {
  finding: CiFinding;
  /** The matched alert number, or undefined if no match was found. */
  alertNumber?: number;
  /** The HTML URL of the matched alert, or undefined. */
  alertUrl?: string;
}

/**
 * Correlate CI findings with code scanning alerts.
 *
 * Matches on: rule.id ↔ finding.rule, tool.name ↔ finding.checkRunName,
 * location.path ↔ finding.file, location.start_line ↔ finding.line,
 * and commit_sha ↔ finding.commitSha.
 *
 * Returns one `CorrelatedFinding` per input finding.  Findings without
 * a matching alert get `alertNumber: undefined`.
 */
export function correlateFindings(
  findings: CiFinding[],
  alerts: CodeScanningAlert[],
): CorrelatedFinding[] {
  // Index alerts for efficient lookup: key = "rule|tool|path|line|sha".
  const alertIndex = new Map<string, CodeScanningAlert>();
  for (const alert of alerts) {
    const key = [
      alert.rule.id,
      alert.tool.name,
      alert.most_recent_instance.location.path,
      alert.most_recent_instance.location.start_line,
      alert.most_recent_instance.commit_sha,
    ].join("|");
    alertIndex.set(key, alert);
  }

  return findings.map((finding) => {
    // Try exact match first (all five fields).
    const exactKey = [
      finding.rule ?? "",
      finding.checkRunName,
      finding.file,
      finding.line,
      finding.commitSha,
    ].join("|");
    const exactMatch = alertIndex.get(exactKey);
    if (exactMatch) {
      return {
        finding,
        alertNumber: exactMatch.number,
        alertUrl: exactMatch.html_url,
      };
    }

    return { finding };
  });
}

/**
 * Dismiss a code scanning alert as a false positive via the GitHub
 * Code Scanning API.
 */
export function dismissCodeScanningAlert(
  owner: string,
  repo: string,
  alertNumber: number,
  reason: string,
): void {
  ghExec([
    "api",
    "-X",
    "PATCH",
    `repos/${owner}/${repo}/code-scanning/alerts/${alertNumber}`,
    "-f",
    "state=dismissed",
    "-f",
    "dismissed_reason=false positive",
    "-f",
    `dismissed_comment=${reason}`,
  ]);
}
