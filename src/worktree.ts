/**
 * Local repository bootstrap and git worktree management.
 *
 * Provides utilities for:
 * - Cloning a repository if missing, or fetching if it exists
 * - Detecting the default branch via `gh repo view`
 * - Creating / reusing / cleaning up worktrees at a deterministic path
 */

import { type ExecFileSyncOptions, execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { t } from "./i18n/index.js";
import { repoLockPath, withLock } from "./lock.js";

// ---- public types --------------------------------------------------------

export type WorktreeConflictChoice = "reuse" | "clean" | "halt";

export interface WorktreeResult {
  /** Absolute path to the worktree directory. */
  path: string;
  /** The branch name created for this worktree. */
  branch: string;
  /** True when the worktree had uncommitted changes (only for "reuse"/"clean"). */
  hadUncommittedChanges: boolean;
  /** Full SHA of the base commit (tip of origin/{baseBranch} at creation time). */
  baseSha: string;
}

// ---- path helpers --------------------------------------------------------

/**
 * Return the deterministic worktree path for a given owner/repo/issue
 * combination:  `~/.agentcoop/worktrees/{owner}/{repo}/issue-{number}`
 */
export function worktreePath(
  owner: string,
  repo: string,
  issueNumber: number,
): string {
  return join(
    homedir(),
    ".agentcoop",
    "worktrees",
    owner,
    repo,
    `issue-${issueNumber}`,
  );
}

/**
 * Return the path to the bare clone used as the main repository:
 * `~/.agentcoop/repos/{owner}/{repo}.git`
 */
export function repoPath(owner: string, repo: string): string {
  return join(homedir(), ".agentcoop", "repos", owner, `${repo}.git`);
}

// ---- default branch detection --------------------------------------------

/**
 * Detect the default branch for `owner/repo` via `gh repo view`.
 */
export function detectDefaultBranch(owner: string, repo: string): string {
  const output = execFileSync(
    "gh",
    ["repo", "view", `${owner}/${repo}`, "--json", "defaultBranchRef"],
    { encoding: "utf-8" },
  );
  const data = JSON.parse(output);
  return data.defaultBranchRef?.name ?? "main";
}

// ---- repo bootstrap ------------------------------------------------------

const EXEC_OPTS: ExecFileSyncOptions = { encoding: "utf-8", stdio: "pipe" };

/**
 * Ensure a bare clone of `owner/repo` exists locally.
 * - Missing → `git clone --bare`
 * - Exists  → `git fetch --all --prune`
 */
export function bootstrapRepo(owner: string, repo: string): string {
  const dest = repoPath(owner, repo);
  const lockPath = repoLockPath(owner, repo);

  withLock(lockPath, () => {
    if (existsSync(dest)) {
      // Ensure the fetch refspec exists — bare clones (including those
      // created before this fix) lack one, making `git fetch` a no-op.
      ensureFetchRefspec(dest);
      execFileSync("git", ["fetch", "--all", "--prune"], {
        ...EXEC_OPTS,
        cwd: dest,
      });
    } else {
      execFileSync(
        "git",
        ["clone", "--bare", `https://github.com/${owner}/${repo}.git`, dest],
        EXEC_OPTS,
      );
      ensureFetchRefspec(dest);
      // After a bare clone the repo only has refs/heads/*; fetch once
      // to populate refs/remotes/origin/* so createWorktree() can
      // reference origin/<baseBranch>.
      execFileSync("git", ["fetch", "--all", "--prune"], {
        ...EXEC_OPTS,
        cwd: dest,
      });
    }
  });

  return dest;
}

const FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

/**
 * Ensure `remote.origin.fetch` uses the correct refspec.
 *
 * `git clone --bare` does not create this config entry, so without it
 * `git fetch --all` has nothing to fetch and local refs stay stale.
 *
 * Existing bare repos may still have the legacy refspec
 * `+refs/heads/*:refs/heads/*` which writes directly into local branch
 * refs and conflicts with checked-out worktree branches.  This function
 * replaces it with the remote-tracking variant.
 */
function ensureFetchRefspec(cwd: string): void {
  let current = "";
  try {
    current = (
      execFileSync("git", ["config", "remote.origin.fetch"], {
        ...EXEC_OPTS,
        cwd,
      }) as string
    ).trim();
  } catch {
    // Config key missing — fall through to set it.
  }
  if (current === FETCH_REFSPEC) return;
  execFileSync("git", ["config", "remote.origin.fetch", FETCH_REFSPEC], {
    ...EXEC_OPTS,
    cwd,
  });
}

// ---- HEAD SHA capture ----------------------------------------------------

/**
 * Return the full commit SHA at HEAD in `cwd`.
 *
 * Used by CI-polling stages to target only workflow runs triggered by
 * the most recent push, avoiding false-pass and stale-failure problems.
 */
export function getHeadSha(cwd: string): string {
  return (
    execFileSync("git", ["rev-parse", "HEAD"], {
      ...EXEC_OPTS,
      cwd,
    }) as string
  ).trim();
}

/**
 * Return the branch currently checked out in a worktree.
 */
function getCheckedOutBranch(wtPath: string): string {
  return (
    execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      ...EXEC_OPTS,
      cwd: wtPath,
    }) as string
  ).trim();
}

/**
 * Resolve the full SHA of `origin/{baseBranch}` in the given worktree.
 *
 * Use this only for freshly created worktrees where HEAD is based on
 * `origin/{baseBranch}`.  For reused worktrees (where origin may have
 * advanced), use {@link resolveMergeBase} instead to find the actual
 * fork point.
 */
export function resolveBaseSha(cwd: string, baseBranch: string): string {
  return (
    execFileSync("git", ["rev-parse", `origin/${baseBranch}`], {
      ...EXEC_OPTS,
      cwd,
    }) as string
  ).trim();
}

/**
 * Find the merge-base between HEAD and `origin/{baseBranch}`.
 *
 * This returns the commit where the current branch diverged from the
 * base branch — the correct squash boundary for reused worktrees
 * where `origin/{baseBranch}` may have advanced since the worktree
 * was originally created.
 */
export function resolveMergeBase(cwd: string, baseBranch: string): string {
  return (
    execFileSync("git", ["merge-base", `origin/${baseBranch}`, "HEAD"], {
      ...EXEC_OPTS,
      cwd,
    }) as string
  ).trim();
}

// ---- branch commit count -------------------------------------------------

/**
 * Return the number of commits on the current branch relative to
 * `baseBranch`.  Used to decide whether squashing is necessary.
 */
export function countBranchCommits(cwd: string, baseBranch: string): number {
  const output = execFileSync(
    "git",
    ["rev-list", "--count", `origin/${baseBranch}..HEAD`],
    { ...EXEC_OPTS, cwd },
  ) as string;
  return Number.parseInt(output.trim(), 10);
}

// ---- worktree management -------------------------------------------------

/**
 * Check whether a worktree directory already exists and contains
 * uncommitted changes.
 */
export function hasUncommittedChanges(wtPath: string): boolean {
  if (!existsSync(wtPath)) return false;
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
      ...EXEC_OPTS,
      cwd: wtPath,
    }) as string;
    return output.trim().length > 0;
  } catch {
    // If git status fails (e.g. not a git directory), treat as no changes.
    return false;
  }
}

/**
 * Force-remove a worktree entry from the bare repo and delete the branch.
 * Errors are silently ignored (the worktree/branch may not exist).
 */
function forceRemoveWorktreeAndBranch(
  bare: string,
  wtPath: string,
  branch: string,
): void {
  try {
    execFileSync("git", ["worktree", "remove", "--force", wtPath], {
      ...EXEC_OPTS,
      cwd: bare,
    });
  } catch {
    // Already removed or never existed.
  }

  rmSync(wtPath, { recursive: true, force: true });

  // Clean up stale worktree metadata so the branch is no longer
  // considered "checked out" — otherwise `git branch -D` (and a
  // subsequent `git worktree add -b`) can fail with a ghost ref.
  execFileSync("git", ["worktree", "prune"], { ...EXEC_OPTS, cwd: bare });

  try {
    execFileSync("git", ["branch", "-D", branch], { ...EXEC_OPTS, cwd: bare });
  } catch {
    // Branch may not exist.
  }
}

/**
 * Create a worktree for the given issue, branching from `baseBranch`.
 *
 * When the target path already exists the caller must provide a
 * `conflictChoice` — otherwise the function throws.  If the existing
 * worktree contains uncommitted changes, `hadUncommittedChanges` in
 * the result will be `true` so the caller can warn the user.
 *
 * @returns The worktree path, branch name, and dirty flag.
 */
export function createWorktree(options: {
  owner: string;
  repo: string;
  issueNumber: number;
  baseBranch: string;
  /**
   * Branch name for the worktree.  Defaults to `issue-{number}`.
   * Stage handlers typically pass `{username}/issue-{number}`.
   */
  branch?: string;
  conflictChoice?: WorktreeConflictChoice;
}): WorktreeResult {
  const { owner, repo, issueNumber, baseBranch, conflictChoice } = options;
  const bare = repoPath(owner, repo);
  const wtPath = worktreePath(owner, repo, issueNumber);
  const branch = options.branch ?? `issue-${issueNumber}`;

  if (existsSync(wtPath)) {
    if (conflictChoice === undefined) {
      throw new Error(t()["worktree.alreadyExists"](wtPath));
    }

    const dirty = hasUncommittedChanges(wtPath);

    if (conflictChoice === "halt") {
      throw new Error(t()["worktree.haltConflict"]);
    }

    if (conflictChoice === "clean") {
      // Detect the actual branch so we remove the right one (it may
      // differ from the requested name for legacy worktrees).
      // Fall back to the requested branch when detection fails (e.g.
      // the path exists but is not a valid git worktree).
      let oldBranch: string;
      try {
        oldBranch = getCheckedOutBranch(wtPath);
      } catch {
        oldBranch = branch;
      }
      const lockPath = repoLockPath(owner, repo);
      withLock(lockPath, () => {
        forceRemoveWorktreeAndBranch(bare, wtPath, oldBranch);

        // Recreate.
        execFileSync(
          "git",
          ["worktree", "add", "-b", branch, wtPath, `origin/${baseBranch}`],
          { ...EXEC_OPTS, cwd: bare },
        );
      });
      const baseSha = resolveBaseSha(wtPath, baseBranch);
      return { path: wtPath, branch, hadUncommittedChanges: dirty, baseSha };
    }

    // "reuse" — detect the actual branch in the worktree, which may
    // differ from the requested name (e.g. legacy `issue-N` worktrees).
    // Use merge-base instead of resolveBaseSha because origin may have
    // advanced since the worktree was originally created; merge-base
    // finds the actual fork point of this branch.
    const actualBranch = getCheckedOutBranch(wtPath);
    const baseSha = resolveMergeBase(wtPath, baseBranch);
    return {
      path: wtPath,
      branch: actualBranch,
      hadUncommittedChanges: dirty,
      baseSha,
    };
  }

  // Create the worktree with a new branch tracking the base branch.
  const lockPath = repoLockPath(owner, repo);
  withLock(lockPath, () => {
    execFileSync(
      "git",
      ["worktree", "add", "-b", branch, wtPath, `origin/${baseBranch}`],
      { ...EXEC_OPTS, cwd: bare },
    );
  });

  const baseSha = resolveBaseSha(wtPath, baseBranch);
  return { path: wtPath, branch, hadUncommittedChanges: false, baseSha };
}

/**
 * Remove a worktree and its branch.  Used during final cleanup (stage 9).
 *
 * @param branch - The branch to delete.  Defaults to `issue-{issueNumber}`
 *   but callers should pass the actual branch name when a custom name was
 *   used during `createWorktree`.
 */
export function removeWorktree(
  owner: string,
  repo: string,
  issueNumber: number,
  branch?: string,
): void {
  const bare = repoPath(owner, repo);
  const wtPath = worktreePath(owner, repo, issueNumber);
  const resolvedBranch = branch ?? `issue-${issueNumber}`;
  forceRemoveWorktreeAndBranch(bare, wtPath, resolvedBranch);
}
