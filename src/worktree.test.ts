import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  rmSync: vi.fn(),
}));

const {
  worktreePath,
  repoPath,
  detectDefaultBranch,
  bootstrapRepo,
  hasUncommittedChanges,
  getHeadSha,
  createWorktree,
  removeWorktree,
} = await import("./worktree.js");

const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockRmSync = vi.mocked(rmSync);

afterEach(() => {
  vi.resetAllMocks();
});

const home = homedir();

// ---------------------------------------------------------------------------
// worktreePath
// ---------------------------------------------------------------------------
describe("worktreePath", () => {
  test("returns deterministic path", () => {
    expect(worktreePath("aicers", "agentcoop", 5)).toBe(
      join(home, ".agentcoop", "worktrees", "aicers", "agentcoop", "issue-5"),
    );
  });

  test("handles different issue numbers", () => {
    expect(worktreePath("org", "repo", 42)).toBe(
      join(home, ".agentcoop", "worktrees", "org", "repo", "issue-42"),
    );
  });
});

// ---------------------------------------------------------------------------
// repoPath
// ---------------------------------------------------------------------------
describe("repoPath", () => {
  test("returns bare clone path", () => {
    expect(repoPath("aicers", "agentcoop")).toBe(
      join(home, ".agentcoop", "repos", "aicers", "agentcoop.git"),
    );
  });
});

// ---------------------------------------------------------------------------
// detectDefaultBranch
// ---------------------------------------------------------------------------
describe("detectDefaultBranch", () => {
  test("parses default branch from gh output", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({ defaultBranchRef: { name: "develop" } }),
    );
    expect(detectDefaultBranch("org", "repo")).toBe("develop");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gh",
      ["repo", "view", "org/repo", "--json", "defaultBranchRef"],
      { encoding: "utf-8" },
    );
  });

  test("falls back to main when defaultBranchRef is null", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({ defaultBranchRef: null }),
    );
    expect(detectDefaultBranch("org", "repo")).toBe("main");
  });

  test("falls back to main when name is missing", () => {
    mockExecFileSync.mockReturnValue(JSON.stringify({ defaultBranchRef: {} }));
    expect(detectDefaultBranch("org", "repo")).toBe("main");
  });
});

// ---------------------------------------------------------------------------
// bootstrapRepo
// ---------------------------------------------------------------------------
describe("bootstrapRepo", () => {
  test("clones when repo does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    const dest = bootstrapRepo("org", "repo");
    expect(dest).toBe(repoPath("org", "repo"));
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["clone", "--bare", "https://github.com/org/repo.git", dest],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  test("fetches when repo already exists", () => {
    const dest = repoPath("org", "repo");
    mockExistsSync.mockReturnValue(true);
    bootstrapRepo("org", "repo");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["fetch", "--all", "--prune"],
      expect.objectContaining({ encoding: "utf-8", cwd: dest }),
    );
  });
});

// ---------------------------------------------------------------------------
// hasUncommittedChanges
// ---------------------------------------------------------------------------
describe("hasUncommittedChanges", () => {
  test("returns false when path does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(hasUncommittedChanges("/some/path")).toBe(false);
  });

  test("returns false when status is clean", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValue("");
    expect(hasUncommittedChanges("/some/path")).toBe(false);
  });

  test("returns true when there are changes", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValue(" M src/index.ts\n");
    expect(hasUncommittedChanges("/some/path")).toBe(true);
  });

  test("returns false when git status fails", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    expect(hasUncommittedChanges("/some/path")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getHeadSha
// ---------------------------------------------------------------------------
describe("getHeadSha", () => {
  test("returns trimmed HEAD SHA", () => {
    mockExecFileSync.mockReturnValue("abc123def456\n");
    expect(getHeadSha("/tmp/wt")).toBe("abc123def456");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "HEAD"],
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  test("propagates error when git fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    expect(() => getHeadSha("/tmp/bad")).toThrow("not a git repo");
  });
});

// ---------------------------------------------------------------------------
// createWorktree
// ---------------------------------------------------------------------------
describe("createWorktree", () => {
  const baseOpts = {
    owner: "org",
    repo: "repo",
    issueNumber: 5,
    baseBranch: "main",
  };

  test("creates worktree when path does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    const result = createWorktree(baseOpts);

    expect(result.path).toBe(worktreePath("org", "repo", 5));
    expect(result.branch).toBe("issue-5");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "-b", "issue-5", result.path, "main"],
      expect.objectContaining({ cwd: repoPath("org", "repo") }),
    );
  });

  test("uses custom branch name when provided", () => {
    mockExistsSync.mockReturnValue(false);
    const result = createWorktree({
      ...baseOpts,
      branch: "alice/issue-5",
    });

    expect(result.branch).toBe("alice/issue-5");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "-b", "alice/issue-5", result.path, "main"],
      expect.objectContaining({ cwd: repoPath("org", "repo") }),
    );
  });

  test("throws when path exists and no conflictChoice given", () => {
    mockExistsSync.mockReturnValue(true);
    expect(() => createWorktree(baseOpts)).toThrow("Worktree already exists");
  });

  test("reuses existing worktree", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValue(""); // git status --porcelain (clean)
    const result = createWorktree({ ...baseOpts, conflictChoice: "reuse" });
    expect(result.path).toBe(worktreePath("org", "repo", 5));
    expect(result.hadUncommittedChanges).toBe(false);
    // Only hasUncommittedChanges call, no git worktree add.
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["status", "--porcelain"],
      expect.objectContaining({ cwd: result.path }),
    );
  });

  test("reuse reports hadUncommittedChanges when dirty", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValue(" M file.ts\n");
    const result = createWorktree({ ...baseOpts, conflictChoice: "reuse" });
    expect(result.hadUncommittedChanges).toBe(true);
  });

  test("halts when user chooses halt", () => {
    mockExistsSync.mockReturnValue(true);
    expect(() =>
      createWorktree({ ...baseOpts, conflictChoice: "halt" }),
    ).toThrow("User chose to halt");
  });

  test("cleans up and recreates when user chooses clean", () => {
    // First call: existsSync for the worktree path → true (conflict)
    // Second call: existsSync inside the new worktree add → false
    mockExistsSync.mockReturnValueOnce(true).mockReturnValue(false);
    const result = createWorktree({ ...baseOpts, conflictChoice: "clean" });

    expect(result.path).toBe(worktreePath("org", "repo", 5));
    expect(mockRmSync).toHaveBeenCalledWith(result.path, {
      recursive: true,
      force: true,
    });
    // Should call git worktree remove, git branch -D, then git worktree add.
    const calls = mockExecFileSync.mock.calls.map((c) => c[1]);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(["worktree", "remove"]),
        expect.arrayContaining(["branch", "-D"]),
        expect.arrayContaining(["worktree", "add"]),
      ]),
    );
  });

  test("clean continues even if worktree remove fails", () => {
    mockExistsSync.mockReturnValueOnce(true).mockReturnValue(false);
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw new Error("worktree remove failed");
      })
      .mockImplementation(() => "" as never);

    // Should not throw — the error is caught.
    const result = createWorktree({ ...baseOpts, conflictChoice: "clean" });
    expect(result.path).toBe(worktreePath("org", "repo", 5));
  });
});

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------
describe("removeWorktree", () => {
  test("removes worktree, directory, and branch", () => {
    removeWorktree("org", "repo", 5);

    const wtPath = worktreePath("org", "repo", 5);
    const bare = repoPath("org", "repo");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", wtPath],
      expect.objectContaining({ cwd: bare }),
    );
    expect(mockRmSync).toHaveBeenCalledWith(wtPath, {
      recursive: true,
      force: true,
    });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["branch", "-D", "issue-5"],
      expect.objectContaining({ cwd: bare }),
    );
  });

  test("does not throw if worktree remove fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("already removed");
    });
    expect(() => removeWorktree("org", "repo", 5)).not.toThrow();
  });

  test("uses custom branch name when provided", () => {
    removeWorktree("org", "repo", 5, "alice/issue-5");

    const bare = repoPath("org", "repo");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["branch", "-D", "alice/issue-5"],
      expect.objectContaining({ cwd: bare }),
    );
  });

  test("defaults to issue-N when branch not provided", () => {
    removeWorktree("org", "repo", 5);

    const bare = repoPath("org", "repo");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["branch", "-D", "issue-5"],
      expect.objectContaining({ cwd: bare }),
    );
  });
});

// ---------------------------------------------------------------------------
// createWorktree — hadUncommittedChanges
// ---------------------------------------------------------------------------
describe("createWorktree — uncommitted changes detection", () => {
  const baseOpts = {
    owner: "org",
    repo: "repo",
    issueNumber: 5,
    baseBranch: "main",
  };

  test("clean reports hadUncommittedChanges when dirty", () => {
    // existsSync: true (worktree exists), true (hasUncommittedChanges path check)
    mockExistsSync.mockReturnValue(true);
    // First call: git status --porcelain (dirty)
    // Subsequent calls: worktree remove, branch -D, worktree add
    mockExecFileSync
      .mockReturnValueOnce(" M dirty.ts\n" as never)
      .mockImplementation(() => "" as never);
    const result = createWorktree({ ...baseOpts, conflictChoice: "clean" });
    expect(result.hadUncommittedChanges).toBe(true);
  });

  test("clean reports hadUncommittedChanges false when clean", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockImplementation(() => "" as never);
    const result = createWorktree({ ...baseOpts, conflictChoice: "clean" });
    expect(result.hadUncommittedChanges).toBe(false);
  });

  test("new worktree always has hadUncommittedChanges false", () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => "" as never);
    const result = createWorktree(baseOpts);
    expect(result.hadUncommittedChanges).toBe(false);
  });

  test("halt still checks uncommitted changes before throwing", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValue(" M dirty.ts\n");
    // halt throws, but hasUncommittedChanges was called before that.
    expect(() =>
      createWorktree({ ...baseOpts, conflictChoice: "halt" }),
    ).toThrow("User chose to halt");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["status", "--porcelain"],
      expect.objectContaining({ cwd: worktreePath("org", "repo", 5) }),
    );
  });
});
