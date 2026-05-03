/**
 * Cleanup utilities — docker compose, remote branch, and PR management.
 *
 * Provides functions that detect and tear down resources created during
 * a pipeline run so the user does not have to clean up manually.
 */

import { type ExecFileSyncOptions, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ghExec } from "./gh-exec.js";

const EXEC_OPTS: ExecFileSyncOptions = { encoding: "utf-8", stdio: "pipe" };

// ---- docker compose -------------------------------------------------------

const COMPOSE_FILES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
];

/**
 * Whether the worktree contains a docker compose file.
 */
export function hasDockerComposeFile(worktreePath: string): boolean {
  return COMPOSE_FILES.some((f) => existsSync(join(worktreePath, f)));
}

/**
 * Whether docker compose services are currently running in the worktree.
 *
 * Returns `false` when docker is not installed, no compose file exists,
 * or no services are up.
 */
export function hasDockerComposeRunning(worktreePath: string): boolean {
  if (!hasDockerComposeFile(worktreePath)) return false;
  try {
    const output = execFileSync(
      "docker",
      ["compose", "ps", "--status", "running", "-q"],
      { ...EXEC_OPTS, cwd: worktreePath },
    ) as string;
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Stop docker compose services in the worktree.  Errors are silently
 * ignored (docker may not be installed or no services may be running).
 */
export function stopDockerCompose(worktreePath: string): void {
  try {
    execFileSync("docker", ["compose", "down"], {
      ...EXEC_OPTS,
      cwd: worktreePath,
    });
  } catch {
    // Ignore — docker may not be available.
  }
}

// ---- remote branch --------------------------------------------------------

/**
 * Check whether a remote branch exists on GitHub.
 */
export function remoteBranchExists(
  owner: string,
  repo: string,
  branch: string,
): boolean {
  try {
    ghExec([
      "api",
      `repos/${owner}/${repo}/git/ref/heads/${branch}`,
      "--silent",
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a remote branch on GitHub.
 */
export function deleteRemoteBranch(
  owner: string,
  repo: string,
  branch: string,
): void {
  ghExec([
    "api",
    "-X",
    "DELETE",
    `repos/${owner}/${repo}/git/refs/heads/${branch}`,
  ]);
}

// ---- pull request ---------------------------------------------------------

/**
 * Close an open PR on GitHub without merging.
 */
export function closePr(owner: string, repo: string, prNumber: number): void {
  ghExec(["pr", "close", String(prNumber), "--repo", `${owner}/${repo}`]);
}
