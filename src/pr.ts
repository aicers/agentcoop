/**
 * Pull request utilities.
 *
 * Wraps `gh pr list` to extract the PR number for a given branch.
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
