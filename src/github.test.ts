import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const { getGitHubUsername, listRepositories, getIssue } = await import(
  "./github.js"
);

const mockExecFileSync = vi.mocked(execFileSync);

afterEach(() => {
  mockExecFileSync.mockReset();
});

// ---------------------------------------------------------------------------
// getGitHubUsername
// ---------------------------------------------------------------------------
describe("getGitHubUsername", () => {
  test("calls gh api user and returns trimmed login", () => {
    mockExecFileSync.mockReturnValue("  octocat\n");

    const result = getGitHubUsername();

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gh",
      ["api", "user", "--jq", ".login"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
    expect(result).toBe("octocat");
  });

  test("throws descriptive error when gh command fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("gh: auth required");
    });
    expect(() => getGitHubUsername()).toThrow(
      "Failed to determine GitHub username",
    );
  });
});

// ---------------------------------------------------------------------------
// listRepositories
// ---------------------------------------------------------------------------
describe("listRepositories", () => {
  test("calls gh with correct arguments and parses output", () => {
    const repos = [
      { name: "repo1", description: "A repo" },
      { name: "repo2", description: "" },
    ];
    mockExecFileSync.mockReturnValue(JSON.stringify(repos));

    const result = listRepositories("aicers");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gh",
      [
        "repo",
        "list",
        "aicers",
        "--json",
        "name,description",
        "--limit",
        "100",
        "--no-archived",
      ],
      expect.objectContaining({ encoding: "utf-8" }),
    );
    expect(result).toEqual(repos);
  });

  test("returns empty array when no repositories exist", () => {
    mockExecFileSync.mockReturnValue("[]");
    const result = listRepositories("empty-org");
    expect(result).toEqual([]);
  });

  test("handles repos with null descriptions", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify([{ name: "repo1", description: null }]),
    );
    const result = listRepositories("org");
    expect(result).toEqual([{ name: "repo1", description: null }]);
  });

  test("propagates error when gh command fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("gh: not found");
    });
    expect(() => listRepositories("org")).toThrow("gh: not found");
  });
});

// ---------------------------------------------------------------------------
// getIssue
// ---------------------------------------------------------------------------
describe("getIssue", () => {
  test("calls gh with correct arguments and parses output", () => {
    const issue = {
      number: 42,
      title: "Fix bug",
      body: "Details here",
      state: "OPEN",
      labels: [{ name: "bug" }],
    };
    mockExecFileSync.mockReturnValue(JSON.stringify(issue));

    const result = getIssue("aicers", "agentcoop", 42);

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gh",
      [
        "issue",
        "view",
        "42",
        "--repo",
        "aicers/agentcoop",
        "--json",
        "number,title,body,state,labels",
      ],
      expect.objectContaining({ encoding: "utf-8" }),
    );
    expect(result).toEqual({
      number: 42,
      title: "Fix bug",
      body: "Details here",
      state: "OPEN",
      labels: ["bug"],
    });
  });

  test("flattens multiple labels into string array", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({
        number: 1,
        title: "t",
        body: "",
        state: "OPEN",
        labels: [{ name: "bug" }, { name: "urgent" }, { name: "p0" }],
      }),
    );
    const result = getIssue("o", "r", 1);
    expect(result.labels).toEqual(["bug", "urgent", "p0"]);
  });

  test("handles issue with empty labels array", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({
        number: 5,
        title: "No labels",
        body: "body",
        state: "OPEN",
        labels: [],
      }),
    );
    const result = getIssue("o", "r", 5);
    expect(result.labels).toEqual([]);
  });

  test("handles issue with null/undefined labels", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({
        number: 6,
        title: "Null labels",
        body: "body",
        state: "OPEN",
        labels: null,
      }),
    );
    const result = getIssue("o", "r", 6);
    expect(result.labels).toEqual([]);
  });

  test("handles issue with null body", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({
        number: 7,
        title: "No body",
        body: null,
        state: "OPEN",
        labels: [],
      }),
    );
    const result = getIssue("o", "r", 7);
    expect(result.body).toBe("");
  });

  test("handles closed issue", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({
        number: 10,
        title: "Done",
        body: "Finished",
        state: "CLOSED",
        labels: [{ name: "done" }],
      }),
    );
    const result = getIssue("o", "r", 10);
    expect(result.state).toBe("CLOSED");
  });

  test("propagates error when gh command fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("issue not found");
    });
    expect(() => getIssue("o", "r", 999)).toThrow("issue not found");
  });
});
