/**
 * Pull request utilities.
 *
 * Wraps `gh` CLI commands to query PR metadata.
 */

import { execFileSync } from "node:child_process";

/**
 * Find the PR number associated with `branch` in `owner/repo`.
 *
 * Returns `undefined` when no PR exists for the branch.
 */
export function findPrNumber(
  owner: string,
  repo: string,
  branch: string,
): number | undefined {
  const output = execFileSync(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      `${owner}/${repo}`,
      "--head",
      branch,
      "--json",
      "number",
      "--limit",
      "1",
    ],
    { encoding: "utf-8" },
  );

  let prs: { number: number }[];
  try {
    prs = JSON.parse(output);
  } catch {
    return undefined;
  }
  return prs.length > 0 ? prs[0].number : undefined;
}

// ---- PR body -----------------------------------------------------------------

/**
 * Read the body of the PR associated with `branch` in `owner/repo`.
 *
 * Returns the body text, or `undefined` if the PR does not exist or
 * the command fails.
 */
export function getPrBody(
  owner: string,
  repo: string,
  branch: string,
): string | undefined {
  try {
    return execFileSync(
      "gh",
      [
        "pr",
        "view",
        "--repo",
        `${owner}/${repo}`,
        branch,
        "--json",
        "body",
        "--jq",
        ".body",
      ],
      { encoding: "utf-8" },
    ).trim();
  } catch {
    return undefined;
  }
}

// ---- mergeable state ---------------------------------------------------------

/**
 * Possible values for the `mergeable` field returned by the GitHub
 * GraphQL API via `gh pr view --json mergeable`.
 */
export type MergeableState = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/**
 * Options for {@link checkMergeable}.  Every field is optional and
 * has a sensible default; the explicit fields exist for testability.
 */
export interface CheckMergeableOptions {
  /** Maximum number of retries when GitHub returns `UNKNOWN`. Default 5. */
  maxRetries?: number;
  /** Initial backoff delay in ms (doubles each retry). Default 2 000. */
  initialDelayMs?: number;
  /** Injected for testability.  Defaults to a real `setTimeout` delay. */
  delay?: (ms: number) => Promise<void>;
  /** Injected for testability.  Defaults to `gh pr view`. */
  queryMergeable?: (
    owner: string,
    repo: string,
    branch: string,
  ) => MergeableState;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Query the raw mergeable state for the PR associated with `branch`.
 *
 * Shells out to `gh pr view --json mergeable`.  Returns `"UNKNOWN"`
 * if the command fails or the output cannot be parsed.
 */
export function queryMergeableState(
  owner: string,
  repo: string,
  branch: string,
): MergeableState {
  try {
    const output = execFileSync(
      "gh",
      [
        "pr",
        "view",
        "--repo",
        `${owner}/${repo}`,
        branch,
        "--json",
        "mergeable",
      ],
      { encoding: "utf-8" },
    );
    const parsed = JSON.parse(output) as { mergeable: string };
    const state = parsed.mergeable;
    if (
      state === "MERGEABLE" ||
      state === "CONFLICTING" ||
      state === "UNKNOWN"
    ) {
      return state;
    }
    return "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

/**
 * Check whether the PR for `branch` is mergeable, retrying with
 * exponential backoff when GitHub returns `UNKNOWN` (merge check
 * still computing).
 *
 * Returns the resolved {@link MergeableState}.
 */
export async function checkMergeable(
  owner: string,
  repo: string,
  branch: string,
  options: CheckMergeableOptions = {},
): Promise<MergeableState> {
  const maxRetries = options.maxRetries ?? 5;
  const initialDelay = options.initialDelayMs ?? 2_000;
  const delay = options.delay ?? defaultDelay;
  const query = options.queryMergeable ?? queryMergeableState;

  let backoff = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const state = query(owner, repo, branch);
    if (state !== "UNKNOWN") {
      return state;
    }
    if (attempt < maxRetries) {
      await delay(backoff);
      backoff *= 2;
    }
  }

  return "UNKNOWN";
}
