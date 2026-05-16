/**
 * Concurrency regression test for #336.
 *
 * Models the production failure: one dispatch is holding the shared repo
 * lock; a sibling dispatch reaches `prepareReviewerWorktree`.  Pre-#336
 * the sibling's `git fetch` ran INSIDE `withLock`, so it had to wait —
 * and if the holder was a hung fetch the sibling tripped `MAX_WAIT_MS`
 * with "Timed out waiting for repo lock".  With the fix, fetch and the
 * per-worktree refresh run OUTSIDE `withLock`, so a sibling proceeds
 * regardless of how long the lock holder takes.
 *
 * Strategy: plant a real lock file (attributed to a live PID, so
 * `lock.ts` cannot treat it as stale) at the path `prepareReviewerWorktree`
 * would use, then call the function.  All work that #336 moved out of
 * the lock — fetch + switch/reset/clean — must run to completion without
 * ever touching the lock, so the call must NOT throw "Timed out waiting
 * for repo lock".  `execFileSync` is mocked so the test doesn't shell
 * out to git.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const { prepareReviewerWorktree, reviewerWorktreePath } = await import(
  "./worktree.js"
);
const { repoLockPath } = await import("./lock.js");

const mockExecFileSync = vi.mocked(execFileSync);

// `os.homedir()` honours $HOME on POSIX but uses USERPROFILE on Windows.
// Skip the test on Windows — the fixture relies on overriding $HOME so
// that `repoLockPath` resolves under our tmp dir.
const itPosix = process.platform === "win32" ? test.skip : test;

describe("prepareReviewerWorktree (#336) — sibling proceeds despite held lock", () => {
  let homeDir: string;
  let bareDir: string;
  let lockPath: string;
  let wtPath: string;
  let origHome: string | undefined;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "agentcoop-336-"));
    origHome = process.env.HOME;
    process.env.HOME = homeDir;
    // Recompute the paths under the test HOME.
    bareDir = join(homeDir, ".agentcoop", "repos", "org", "repo.git");
    lockPath = repoLockPath("org", "repo");
    wtPath = reviewerWorktreePath("org", "repo", 5);
    mkdirSync(bareDir, { recursive: true });
    mkdirSync(wtPath, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(homeDir, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  itPosix(
    "fetch + refresh complete without acquiring the repo lock",
    () => {
      // Plant a held lock file attributed to a live PID (our own).
      // lock.ts probes the holder with process.kill(pid, 0); using
      // process.pid guarantees the probe says "alive", so lock.ts will
      // NOT treat it as stale and remove it.  Any call that tries to
      // acquireLock now must wait for MAX_WAIT_MS and then throw.
      mkdirSync(join(homeDir, ".agentcoop", "repos", "org"), {
        recursive: true,
      });
      writeFileSync(lockPath, `${process.pid}:${Date.now()}`);
      expect(existsSync(lockPath)).toBe(true);

      // The refresh path needs isValidGitWorktree(wtPath) === true.
      // That calls rev-parse --is-inside-work-tree; return "true" so
      // we go down the refresh branch (NOT the recreate-under-lock
      // branch).
      mockExecFileSync.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === "git" && args[0] === "rev-parse") return "true\n";
        return "" as never;
      }) as typeof execFileSync);

      const start = Date.now();
      const result = prepareReviewerWorktree({
        owner: "org",
        repo: "repo",
        issueNumber: 5,
        authorBranch: "alice/issue-5",
      });
      const elapsed = Date.now() - start;

      expect(result).toBe(wtPath);
      // Pre-#336 this would have blocked for MAX_WAIT_MS (120 s) and
      // then thrown.  Post-fix the call returns essentially immediately.
      expect(elapsed).toBeLessThan(5_000);

      const issued = mockExecFileSync.mock.calls.map(
        (c) => (c[1] as string[])[0],
      );
      // Refresh-path commands ran:
      expect(issued).toContain("fetch");
      expect(issued).toContain("switch");
      expect(issued).toContain("reset");
      expect(issued).toContain("clean");
      // The recreate path (which acquires the lock) was NOT taken:
      expect(issued).not.toContain("worktree");
    },
    // Wall-clock budget for the test itself.  If the fix regresses and
    // fetch/refresh acquire the lock again, this entire test would take
    // MAX_WAIT_MS (120 s) — well past this 10 s budget.
    10_000,
  );
});
