import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const { fetchPrComments, findLatestCommentWithMarker } = await import(
  "./pr-comments.js"
);

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

describe("findLatestCommentWithMarker", () => {
  const MARKER = "<!-- agentcoop:squash-suggestion:start -->";

  test("returns undefined when no comment matches", () => {
    const page = [
      { body: "Random comment", user: { login: "a" } },
      { body: "Another comment", user: { login: "b" } },
    ];
    mockExecFileSync.mockReturnValue(JSON.stringify([page]));
    expect(
      findLatestCommentWithMarker("org", "repo", 1, MARKER),
    ).toBeUndefined();
  });

  test("returns the id and body of the latest matching comment", () => {
    // Older matching comment followed by a newer matching comment —
    // the newer one wins.
    const page = [
      { id: 11, body: `older ${MARKER} v1`, user: { login: "a" } },
      { id: 12, body: "noise", user: { login: "b" } },
      { id: 13, body: `newer ${MARKER} v2`, user: { login: "a" } },
    ];
    mockExecFileSync.mockReturnValue(JSON.stringify([page]));
    expect(findLatestCommentWithMarker("org", "repo", 1, MARKER)).toEqual({
      id: 13,
      body: `newer ${MARKER} v2`,
    });
  });

  test("returns id undefined when API response omits id", () => {
    const page = [{ body: `body ${MARKER}`, user: { login: "a" } }];
    mockExecFileSync.mockReturnValue(JSON.stringify([page]));
    expect(findLatestCommentWithMarker("org", "repo", 1, MARKER)).toEqual({
      id: undefined,
      body: `body ${MARKER}`,
    });
  });

  test("propagates errors when the gh call throws", () => {
    // Issue #304 reviewer round 2: lookup failures must surface to the
    // caller so the write side can distinguish "no matching comment"
    // from "lookup failed" and refuse to POST a duplicate suggestion
    // comment on a transient API blip.
    mockExecFileSync.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => findLatestCommentWithMarker("org", "repo", 1, MARKER)).toThrow(
      "boom",
    );
  });
});
