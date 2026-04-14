/**
 * CI status polling and failure log collection.
 *
 * Wraps `gh run list` and `gh run view` to determine whether CI checks
 * pass for a given branch/commit.  Reusable by stages 5, 7, and 8.
 */

import { execFileSync } from "node:child_process";

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
  const output = execFileSync(
    "gh",
    [
      "api",
      `repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
    ],
    { encoding: "utf-8" },
  );

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
      const raw = execFileSync(
        "gh",
        ["api", `repos/${owner}/${repo}/check-runs/${checkRunId}`],
        { encoding: "utf-8" },
      );
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

  // Fetch annotations when present, paginating to collect all pages.
  // --slurp wraps each page into an outer JSON array so the entire
  // output is valid JSON even when multiple pages are returned.
  if (annotationsCount != null && annotationsCount > 0) {
    try {
      const raw = execFileSync(
        "gh",
        [
          "api",
          "--paginate",
          "--slurp",
          `repos/${owner}/${repo}/check-runs/${checkRunId}/annotations?per_page=100`,
        ],
        { encoding: "utf-8" },
      );
      const pages: CheckRunAnnotation[][] = JSON.parse(raw);
      const annotations: CheckRunAnnotation[] = pages.flat();
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
  const output = execFileSync("gh", args, { encoding: "utf-8" });
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
 */
export function getCiStatus(
  owner: string,
  repo: string,
  branch: string,
  commitSha?: string,
): CiStatus {
  const runs = fetchCiRuns(owner, repo, branch, commitSha);
  return { verdict: evaluateCiRuns(runs), runs };
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
  const output = execFileSync(
    "gh",
    [
      "run",
      "view",
      String(run.databaseId),
      "--repo",
      `${owner}/${repo}`,
      "--log-failed",
    ],
    { encoding: "utf-8" },
  );
  return typeof output === "string" ? output : "";
}
