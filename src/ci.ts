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

export interface CiRun {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string;
  headBranch: string;
  headSha: string;
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

// ---- gh CLI wrappers -----------------------------------------------------

/**
 * Fetch the latest CI runs for `branch` in `owner/repo`.
 *
 * When `commitSha` is provided, uses `gh run list --commit` to let
 * the server filter by SHA.  This avoids pagination issues where the
 * target commit's runs could be paged out on high-activity branches.
 */
export function fetchCiRuns(
  owner: string,
  repo: string,
  branch: string,
  commitSha?: string,
): CiRun[] {
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
  try {
    return JSON.parse(output);
  } catch {
    return [];
  }
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
 * Collect failure logs for a specific run ID.
 */
export function collectFailureLogs(
  owner: string,
  repo: string,
  runId: number,
): string {
  const output = execFileSync(
    "gh",
    [
      "run",
      "view",
      String(runId),
      "--repo",
      `${owner}/${repo}`,
      "--log-failed",
    ],
    { encoding: "utf-8" },
  );
  return typeof output === "string" ? output : "";
}
