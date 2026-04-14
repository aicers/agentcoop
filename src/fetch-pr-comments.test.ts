import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const { fetchPrComments } = await import("./pr-comments.js");

const mockExecFileSync = vi.mocked(execFileSync);

afterEach(() => {
  mockExecFileSync.mockReset();
});

describe("fetchPrComments", () => {
  test("passes --paginate and --slurp to gh api", () => {
    mockExecFileSync.mockReturnValue("[[]]");
    fetchPrComments("org", "repo", 5);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gh",
      ["api", "repos/org/repo/issues/5/comments", "--paginate", "--slurp"],
      { encoding: "utf-8" },
    );
  });

  test("flattens multi-page slurp output into a single array", () => {
    // --slurp wraps each page in an outer array: [[page1...], [page2...]]
    const page1 = [
      { body: "comment 1", user: { login: "a" } },
      { body: "comment 2", user: { login: "b" } },
    ];
    const page2 = [{ body: "comment 3", user: { login: "a" } }];
    mockExecFileSync.mockReturnValue(JSON.stringify([page1, page2]));

    const result = fetchPrComments("org", "repo", 10);
    expect(result).toEqual([...page1, ...page2]);
    expect(result).toHaveLength(3);
  });

  test("handles single-page slurp output", () => {
    const page = [{ body: "only comment", user: { login: "a" } }];
    mockExecFileSync.mockReturnValue(JSON.stringify([page]));

    const result = fetchPrComments("org", "repo", 1);
    expect(result).toEqual(page);
    expect(result).toHaveLength(1);
  });

  test("returns empty array when PR has no comments", () => {
    // --slurp with zero results still produces [[]]
    mockExecFileSync.mockReturnValue("[[]]");

    const result = fetchPrComments("org", "repo", 1);
    expect(result).toEqual([]);
  });
});
