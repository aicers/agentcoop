import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const {
  checkMergeable,
  findPrNumber,
  getPrBody,
  queryMergeableState,
  queryPrState,
} = await import("./pr.js");

const mockExecFileSync = vi.mocked(execFileSync);

afterEach(() => {
  mockExecFileSync.mockReset();
});

// ---------------------------------------------------------------------------
// findPrNumber
// ---------------------------------------------------------------------------
describe("findPrNumber", () => {
  test("returns PR number when a PR exists", () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([{ number: 42 }]));
    expect(findPrNumber("org", "repo", "issue-5")).toBe(42);
  });

  test("calls gh with correct arguments", () => {
    mockExecFileSync.mockReturnValue("[]");
    findPrNumber("aicers", "agentcoop", "issue-10");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        "aicers/agentcoop",
        "--head",
        "issue-10",
        "--json",
        "number",
        "--limit",
        "1",
      ],
      { encoding: "utf-8" },
    );
  });

  test("returns undefined when no PR exists", () => {
    mockExecFileSync.mockReturnValue("[]");
    expect(findPrNumber("org", "repo", "issue-5")).toBeUndefined();
  });

  test("returns the first PR when multiple exist", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify([{ number: 10 }, { number: 20 }]),
    );
    expect(findPrNumber("org", "repo", "issue-5")).toBe(10);
  });

  test("propagates error when gh command fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("gh: auth required");
    });
    expect(() => findPrNumber("org", "repo", "issue-5")).toThrow(
      "gh: auth required",
    );
  });

  test("returns undefined on malformed JSON output", () => {
    mockExecFileSync.mockReturnValue("not json at all");
    expect(findPrNumber("org", "repo", "issue-5")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getPrBody
// ---------------------------------------------------------------------------
describe("getPrBody", () => {
  test("returns trimmed PR body text", () => {
    mockExecFileSync.mockReturnValue("  Some PR body\n");
    expect(getPrBody("org", "repo", "branch")).toBe("Some PR body");
  });

  test("calls gh with correct arguments", () => {
    mockExecFileSync.mockReturnValue("body");
    getPrBody("aicers", "agentcoop", "issue-42");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gh",
      [
        "pr",
        "view",
        "--repo",
        "aicers/agentcoop",
        "issue-42",
        "--json",
        "body",
        "--jq",
        ".body",
      ],
      { encoding: "utf-8" },
    );
  });

  test("returns undefined when gh command fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("gh: not authenticated");
    });
    expect(getPrBody("org", "repo", "branch")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// queryMergeableState
// ---------------------------------------------------------------------------
describe("queryMergeableState", () => {
  test("returns MERGEABLE when gh reports mergeable", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({ mergeable: "MERGEABLE" }),
    );
    expect(queryMergeableState("org", "repo", "branch")).toBe("MERGEABLE");
  });

  test("returns CONFLICTING when gh reports conflicting", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({ mergeable: "CONFLICTING" }),
    );
    expect(queryMergeableState("org", "repo", "branch")).toBe("CONFLICTING");
  });

  test("returns UNKNOWN when gh reports unknown", () => {
    mockExecFileSync.mockReturnValue(JSON.stringify({ mergeable: "UNKNOWN" }));
    expect(queryMergeableState("org", "repo", "branch")).toBe("UNKNOWN");
  });

  test("returns UNKNOWN for unexpected mergeable value", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({ mergeable: "SOMETHING_ELSE" }),
    );
    expect(queryMergeableState("org", "repo", "branch")).toBe("UNKNOWN");
  });

  test("returns UNKNOWN when gh command throws", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("gh: not authenticated");
    });
    expect(queryMergeableState("org", "repo", "branch")).toBe("UNKNOWN");
  });

  test("returns UNKNOWN on malformed JSON output", () => {
    mockExecFileSync.mockReturnValue("not json");
    expect(queryMergeableState("org", "repo", "branch")).toBe("UNKNOWN");
  });

  test("calls gh with correct arguments", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({ mergeable: "MERGEABLE" }),
    );
    queryMergeableState("aicers", "agentcoop", "feature-branch");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gh",
      [
        "pr",
        "view",
        "--repo",
        "aicers/agentcoop",
        "feature-branch",
        "--json",
        "mergeable",
      ],
      { encoding: "utf-8" },
    );
  });
});

// ---------------------------------------------------------------------------
// queryPrState
// ---------------------------------------------------------------------------
describe("queryPrState", () => {
  test("returns MERGED when gh reports merged", () => {
    mockExecFileSync.mockReturnValue(JSON.stringify({ state: "MERGED" }));
    expect(queryPrState("org", "repo", "branch")).toBe("MERGED");
  });

  test("returns CLOSED when gh reports closed", () => {
    mockExecFileSync.mockReturnValue(JSON.stringify({ state: "CLOSED" }));
    expect(queryPrState("org", "repo", "branch")).toBe("CLOSED");
  });

  test("returns OPEN when gh reports open", () => {
    mockExecFileSync.mockReturnValue(JSON.stringify({ state: "OPEN" }));
    expect(queryPrState("org", "repo", "branch")).toBe("OPEN");
  });

  test("fails open (OPEN) on unexpected state value", () => {
    mockExecFileSync.mockReturnValue(JSON.stringify({ state: "WEIRD" }));
    expect(queryPrState("org", "repo", "branch")).toBe("OPEN");
  });

  test("fails open (OPEN) when gh command throws", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("gh: not authenticated");
    });
    expect(queryPrState("org", "repo", "branch")).toBe("OPEN");
  });

  test("fails open (OPEN) on malformed JSON output", () => {
    mockExecFileSync.mockReturnValue("not json");
    expect(queryPrState("org", "repo", "branch")).toBe("OPEN");
  });

  test("calls gh with correct arguments", () => {
    mockExecFileSync.mockReturnValue(JSON.stringify({ state: "OPEN" }));
    queryPrState("aicers", "agentcoop", "feature-branch");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gh",
      [
        "pr",
        "view",
        "--repo",
        "aicers/agentcoop",
        "feature-branch",
        "--json",
        "state",
      ],
      { encoding: "utf-8" },
    );
  });
});

// ---------------------------------------------------------------------------
// checkMergeable
// ---------------------------------------------------------------------------
describe("checkMergeable", () => {
  const noDelay = async () => {};

  test("returns MERGEABLE immediately when first query succeeds", async () => {
    const query = vi.fn().mockReturnValue("MERGEABLE");
    const result = await checkMergeable("o", "r", "b", {
      queryMergeable: query,
      delay: noDelay,
    });
    expect(result).toBe("MERGEABLE");
    expect(query).toHaveBeenCalledOnce();
  });

  test("returns CONFLICTING immediately without retrying", async () => {
    const query = vi.fn().mockReturnValue("CONFLICTING");
    const result = await checkMergeable("o", "r", "b", {
      queryMergeable: query,
      delay: noDelay,
    });
    expect(result).toBe("CONFLICTING");
    expect(query).toHaveBeenCalledOnce();
  });

  test("retries on UNKNOWN and resolves to MERGEABLE", async () => {
    const query = vi
      .fn()
      .mockReturnValueOnce("UNKNOWN")
      .mockReturnValueOnce("UNKNOWN")
      .mockReturnValueOnce("MERGEABLE");
    const result = await checkMergeable("o", "r", "b", {
      queryMergeable: query,
      delay: noDelay,
      maxRetries: 5,
    });
    expect(result).toBe("MERGEABLE");
    expect(query).toHaveBeenCalledTimes(3);
  });

  test("returns UNKNOWN after exhausting retries", async () => {
    const query = vi.fn().mockReturnValue("UNKNOWN");
    const result = await checkMergeable("o", "r", "b", {
      queryMergeable: query,
      delay: noDelay,
      maxRetries: 3,
    });
    expect(result).toBe("UNKNOWN");
    // 1 initial + 3 retries = 4 total
    expect(query).toHaveBeenCalledTimes(4);
  });

  test("uses exponential backoff delays", async () => {
    const query = vi.fn().mockReturnValue("UNKNOWN");
    const delays: number[] = [];
    const delay = async (ms: number) => {
      delays.push(ms);
    };
    await checkMergeable("o", "r", "b", {
      queryMergeable: query,
      delay,
      maxRetries: 3,
      initialDelayMs: 100,
    });
    expect(delays).toEqual([100, 200, 400]);
  });

  test("does not delay after last retry", async () => {
    const query = vi.fn().mockReturnValue("UNKNOWN");
    const delays: number[] = [];
    const delay = async (ms: number) => {
      delays.push(ms);
    };
    await checkMergeable("o", "r", "b", {
      queryMergeable: query,
      delay,
      maxRetries: 2,
      initialDelayMs: 50,
    });
    // 2 retries → 2 delays (after attempt 0 and 1, not after attempt 2)
    expect(delays).toEqual([50, 100]);
  });

  test("defaults to 5 retries when maxRetries not specified", async () => {
    const query = vi.fn().mockReturnValue("UNKNOWN");
    await checkMergeable("o", "r", "b", {
      queryMergeable: query,
      delay: noDelay,
    });
    // 1 initial + 5 retries = 6 total
    expect(query).toHaveBeenCalledTimes(6);
  });
});
