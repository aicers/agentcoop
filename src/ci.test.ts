import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const {
  evaluateCiRuns,
  normaliseCiConclusion,
  fetchCiRuns,
  getCiStatus,
  collectFailureLogs,
} = await import("./ci.js");

const mockExecFileSync = vi.mocked(execFileSync);

afterEach(() => {
  mockExecFileSync.mockReset();
});

// ---- helpers -------------------------------------------------------------

function run(
  overrides: Partial<{
    databaseId: number;
    name: string;
    status: string;
    conclusion: string;
    headBranch: string;
    headSha: string;
    source: "workflow" | "check";
    checkOutput: {
      title: string | null;
      summary: string | null;
      text: string | null;
    };
    annotationsCount: number;
  }> = {},
) {
  return {
    databaseId: 1,
    name: "CI",
    status: "completed",
    conclusion: "success",
    headBranch: "main",
    headSha: "abc123",
    source: "workflow" as const,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normaliseCiConclusion
// ---------------------------------------------------------------------------
describe("normaliseCiConclusion", () => {
  test("in_progress → pending", () => {
    expect(normaliseCiConclusion(run({ status: "in_progress" }))).toBe(
      "pending",
    );
  });

  test("queued → pending", () => {
    expect(normaliseCiConclusion(run({ status: "queued" }))).toBe("pending");
  });

  test("waiting → pending", () => {
    expect(normaliseCiConclusion(run({ status: "waiting" }))).toBe("pending");
  });

  test("requested → pending", () => {
    expect(normaliseCiConclusion(run({ status: "requested" }))).toBe("pending");
  });

  test("pending status → pending", () => {
    expect(normaliseCiConclusion(run({ status: "pending" }))).toBe("pending");
  });

  test("completed + success → success", () => {
    expect(normaliseCiConclusion(run())).toBe("success");
  });

  test("completed + neutral → success", () => {
    expect(normaliseCiConclusion(run({ conclusion: "neutral" }))).toBe(
      "success",
    );
  });

  test("completed + skipped → skipped", () => {
    expect(normaliseCiConclusion(run({ conclusion: "skipped" }))).toBe(
      "skipped",
    );
  });

  test("completed + cancelled → cancelled", () => {
    expect(normaliseCiConclusion(run({ conclusion: "cancelled" }))).toBe(
      "cancelled",
    );
  });

  test("completed + failure → failure", () => {
    expect(normaliseCiConclusion(run({ conclusion: "failure" }))).toBe(
      "failure",
    );
  });

  test("completed + unknown conclusion → failure", () => {
    expect(normaliseCiConclusion(run({ conclusion: "timed_out" }))).toBe(
      "failure",
    );
  });

  test("handles mixed case", () => {
    expect(normaliseCiConclusion(run({ status: "In_Progress" }))).toBe(
      "pending",
    );
    expect(normaliseCiConclusion(run({ conclusion: "SUCCESS" }))).toBe(
      "success",
    );
  });
});

// ---------------------------------------------------------------------------
// evaluateCiRuns
// ---------------------------------------------------------------------------
describe("evaluateCiRuns", () => {
  test("all success → pass", () => {
    expect(evaluateCiRuns([run(), run()])).toBe("pass");
  });

  test("empty array → pass", () => {
    expect(evaluateCiRuns([])).toBe("pass");
  });

  test("all skipped → pass", () => {
    expect(
      evaluateCiRuns([
        run({ conclusion: "skipped" }),
        run({ conclusion: "skipped" }),
      ]),
    ).toBe("pass");
  });

  test("any failure → fail", () => {
    expect(evaluateCiRuns([run(), run({ conclusion: "failure" })])).toBe(
      "fail",
    );
  });

  test("any cancelled → fail", () => {
    expect(evaluateCiRuns([run(), run({ conclusion: "cancelled" })])).toBe(
      "fail",
    );
  });

  test("pending without failure → pending", () => {
    expect(evaluateCiRuns([run(), run({ status: "in_progress" })])).toBe(
      "pending",
    );
  });

  test("failure takes precedence over pending", () => {
    expect(
      evaluateCiRuns([
        run({ status: "in_progress" }),
        run({ conclusion: "failure" }),
      ]),
    ).toBe("fail");
  });

  test("mix of success and skipped → pass", () => {
    expect(evaluateCiRuns([run(), run({ conclusion: "skipped" })])).toBe(
      "pass",
    );
  });

  test("neutral conclusion → pass", () => {
    expect(evaluateCiRuns([run({ conclusion: "neutral" })])).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// fetchCiRuns
// ---------------------------------------------------------------------------
describe("fetchCiRuns", () => {
  test("calls gh with correct arguments including headSha", () => {
    mockExecFileSync.mockReturnValue("[]");
    fetchCiRuns("org", "repo", "issue-5");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gh",
      [
        "run",
        "list",
        "--repo",
        "org/repo",
        "--branch",
        "issue-5",
        "--json",
        "databaseId,name,status,conclusion,headBranch,headSha",
        "--limit",
        "100",
      ],
      { encoding: "utf-8" },
    );
  });

  test("parses JSON output", () => {
    const runs = [run({ databaseId: 100, name: "build" })];
    mockExecFileSync.mockReturnValue(JSON.stringify(runs));
    expect(fetchCiRuns("org", "repo", "main")).toEqual(runs);
  });

  test("passes --commit flag when commitSha is provided", () => {
    mockExecFileSync.mockReturnValue("[]");
    fetchCiRuns("org", "repo", "main", "abc123");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gh",
      [
        "run",
        "list",
        "--repo",
        "org/repo",
        "--branch",
        "main",
        "--json",
        "databaseId,name,status,conclusion,headBranch,headSha",
        "--limit",
        "100",
        "--commit",
        "abc123",
      ],
      { encoding: "utf-8" },
    );
  });

  test("omits --commit flag when commitSha is not provided", () => {
    mockExecFileSync.mockReturnValue("[]");
    fetchCiRuns("org", "repo", "main");
    const args = mockExecFileSync.mock.calls[0][1] as string[];
    expect(args).not.toContain("--commit");
  });

  test("merges workflow runs and non-Actions check runs", () => {
    const workflowRun = {
      databaseId: 1,
      name: "CI",
      status: "completed",
      conclusion: "success",
      headBranch: "main",
      headSha: "abc123",
    };
    const checkRunsResponse = {
      check_runs: [
        {
          id: 500,
          name: "CodeQL",
          status: "completed",
          conclusion: "failure",
          head_sha: "abc123",
          output: { title: null, summary: null, text: null },
          annotations_count: 0,
          app: { slug: "github-code-scanning" },
        },
        {
          id: 501,
          name: "build",
          status: "completed",
          conclusion: "success",
          head_sha: "abc123",
          output: { title: null, summary: null, text: null },
          annotations_count: 0,
          app: { slug: "github-actions" },
        },
      ],
    };

    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify([workflowRun]))
      .mockReturnValueOnce(JSON.stringify(checkRunsResponse));

    const result = fetchCiRuns("org", "repo", "main", "abc123");

    // Workflow run + CodeQL check run (github-actions filtered out).
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(
      expect.objectContaining({
        databaseId: 1,
        name: "CI",
        source: "workflow",
      }),
    );
    expect(result[1]).toEqual(
      expect.objectContaining({
        databaseId: 500,
        name: "CodeQL",
        source: "check",
        conclusion: "failure",
        checkOutput: { title: null, summary: null, text: null },
        annotationsCount: 0,
      }),
    );
  });

  test("uses commitSha as ref for check runs API", () => {
    mockExecFileSync
      .mockReturnValueOnce("[]")
      .mockReturnValueOnce(JSON.stringify({ check_runs: [] }));

    fetchCiRuns("org", "repo", "main", "deadbeef");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gh",
      ["api", "repos/org/repo/commits/deadbeef/check-runs?per_page=100"],
      { encoding: "utf-8" },
    );
  });

  test("uses branch as ref for check runs when no commitSha", () => {
    mockExecFileSync
      .mockReturnValueOnce("[]")
      .mockReturnValueOnce(JSON.stringify({ check_runs: [] }));

    fetchCiRuns("org", "repo", "my-branch");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gh",
      ["api", "repos/org/repo/commits/my-branch/check-runs?per_page=100"],
      { encoding: "utf-8" },
    );
  });

  test("URL-encodes branch ref containing slashes", () => {
    mockExecFileSync
      .mockReturnValueOnce("[]")
      .mockReturnValueOnce(JSON.stringify({ check_runs: [] }));

    fetchCiRuns("org", "repo", "user/issue-42");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gh",
      ["api", "repos/org/repo/commits/user%2Fissue-42/check-runs?per_page=100"],
      { encoding: "utf-8" },
    );
  });

  test("throws when check runs API fails", () => {
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify([{ ...run(), source: undefined }]))
      .mockImplementationOnce(() => {
        throw new Error("API error");
      });

    expect(() => fetchCiRuns("org", "repo", "main")).toThrow("API error");
  });

  test("filters out github-actions check runs to avoid duplicates", () => {
    const checkRunsResponse = {
      check_runs: [
        {
          id: 10,
          name: "Actions check",
          status: "completed",
          conclusion: "success",
          head_sha: "abc",
          output: { title: null, summary: null, text: null },
          annotations_count: 0,
          app: { slug: "github-actions" },
        },
        {
          id: 11,
          name: "External check",
          status: "completed",
          conclusion: "success",
          head_sha: "abc",
          output: { title: null, summary: null, text: null },
          annotations_count: 0,
          app: { slug: "some-app" },
        },
      ],
    };

    mockExecFileSync
      .mockReturnValueOnce("[]")
      .mockReturnValueOnce(JSON.stringify(checkRunsResponse));

    const result = fetchCiRuns("org", "repo", "main");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("External check");
  });
});

// ---------------------------------------------------------------------------
// getCiStatus
// ---------------------------------------------------------------------------
describe("getCiStatus", () => {
  test("returns pass verdict for successful runs", () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([run()]));
    const status = getCiStatus("org", "repo", "main");
    expect(status.verdict).toBe("pass");
    expect(status.runs).toHaveLength(1);
  });

  test("returns fail verdict for failed runs", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify([run({ conclusion: "failure" })]),
    );
    expect(getCiStatus("org", "repo", "main").verdict).toBe("fail");
  });

  test("returns pending verdict for in-progress runs", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify([run({ status: "in_progress" })]),
    );
    expect(getCiStatus("org", "repo", "main").verdict).toBe("pending");
  });

  test("passes commitSha to fetchCiRuns and evaluates filtered result", () => {
    // Server returns only the matching run (via --commit flag).
    mockExecFileSync.mockReturnValue(
      JSON.stringify([run({ headSha: "aaa", conclusion: "success" })]),
    );
    const status = getCiStatus("org", "repo", "main", "aaa");
    expect(status.verdict).toBe("pass");
    expect(status.runs).toHaveLength(1);
    // Verify --commit was passed to gh.
    const args = mockExecFileSync.mock.calls[0][1] as string[];
    expect(args).toContain("--commit");
    expect(args).toContain("aaa");
  });

  test("returns pass when server returns no runs for commitSha", () => {
    mockExecFileSync.mockReturnValue("[]");
    const status = getCiStatus("org", "repo", "main", "zzz");
    expect(status.verdict).toBe("pass");
    expect(status.runs).toEqual([]);
  });

  test("failing check run causes fail verdict", () => {
    const checkRunsResponse = {
      check_runs: [
        {
          id: 500,
          name: "CodeQL",
          status: "completed",
          conclusion: "failure",
          head_sha: "abc123",
          output: { title: null, summary: null, text: null },
          annotations_count: 0,
          app: { slug: "github-code-scanning" },
        },
      ],
    };

    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify([run()]))
      .mockReturnValueOnce(JSON.stringify(checkRunsResponse));

    const status = getCiStatus("org", "repo", "main");
    expect(status.verdict).toBe("fail");
    expect(status.runs).toHaveLength(2);
    expect(status.runs[1]).toEqual(
      expect.objectContaining({ name: "CodeQL", source: "check" }),
    );
  });
});

// ---------------------------------------------------------------------------
// collectFailureLogs
// ---------------------------------------------------------------------------
describe("collectFailureLogs", () => {
  test("calls gh run view with --log-failed for workflow runs", () => {
    mockExecFileSync.mockReturnValue("error log output");
    const logs = collectFailureLogs("org", "repo", run({ databaseId: 12345 }));
    expect(logs).toBe("error log output");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gh",
      ["run", "view", "12345", "--repo", "org/repo", "--log-failed"],
      { encoding: "utf-8" },
    );
  });

  test("propagates error when gh command fails for workflow runs", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("run not found");
    });
    expect(() =>
      collectFailureLogs("org", "repo", run({ databaseId: 999 })),
    ).toThrow("run not found");
  });

  test("returns empty string when logs are empty for workflow runs", () => {
    mockExecFileSync.mockReturnValue("");
    expect(collectFailureLogs("org", "repo", run({ databaseId: 1 }))).toBe("");
  });

  test("uses carried-forward output and skips detail re-fetch", () => {
    const annotations = [
      {
        path: "src/auth.ts",
        start_line: 42,
        end_line: 42,
        annotation_level: "failure",
        message: "SQL injection vulnerability",
      },
    ];

    // Only one call expected: annotations (no detail re-fetch).
    // --slurp wraps pages in an outer array.
    mockExecFileSync.mockReturnValueOnce(JSON.stringify([annotations]));

    const logs = collectFailureLogs(
      "org",
      "repo",
      run({
        databaseId: 500,
        source: "check",
        checkOutput: {
          title: "2 vulnerabilities found",
          summary: "SQL injection in auth.ts",
          text: "Detailed explanation here.",
        },
        annotationsCount: 1,
      }),
    );
    expect(logs).toContain("Title: 2 vulnerabilities found");
    expect(logs).toContain("Summary: SQL injection in auth.ts");
    expect(logs).toContain("Details: Detailed explanation here.");
    expect(logs).toContain("src/auth.ts:42: [failure] SQL injection");
    // Detail was NOT re-fetched.
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gh",
      [
        "api",
        "--paginate",
        "--slurp",
        "repos/org/repo/check-runs/500/annotations?per_page=100",
      ],
      { encoding: "utf-8" },
    );
  });

  test("re-fetches detail when checkOutput is not carried forward", () => {
    const detail = {
      id: 500,
      name: "CodeQL",
      status: "completed",
      conclusion: "failure",
      head_sha: "abc",
      output: {
        title: "2 vulnerabilities found",
        summary: "SQL injection in auth.ts",
        text: "Detailed explanation here.",
      },
      annotations_count: 1,
    };
    const annotations = [
      {
        path: "src/auth.ts",
        start_line: 42,
        end_line: 42,
        annotation_level: "failure",
        message: "SQL injection vulnerability",
      },
    ];

    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(detail))
      // --slurp wraps pages in an outer array.
      .mockReturnValueOnce(JSON.stringify([annotations]));

    const logs = collectFailureLogs(
      "org",
      "repo",
      run({ databaseId: 500, source: "check" }),
    );
    expect(logs).toContain("Title: 2 vulnerabilities found");
    expect(logs).toContain("Summary: SQL injection in auth.ts");
    expect(logs).toContain("Details: Detailed explanation here.");
    expect(logs).toContain("src/auth.ts:42: [failure] SQL injection");
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  test("returns output-only context when annotations fetch fails", () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("network error");
    });

    const logs = collectFailureLogs(
      "org",
      "repo",
      run({
        databaseId: 600,
        source: "check",
        checkOutput: {
          title: "Analysis failed",
          summary: "Build error during analysis",
          text: null,
        },
        annotationsCount: 1,
      }),
    );
    expect(logs).toContain("Title: Analysis failed");
    expect(logs).toContain("Summary: Build error during analysis");
    expect(logs).not.toContain("Annotations");
  });

  test("skips annotation fetch when annotations_count is 0", () => {
    const logs = collectFailureLogs(
      "org",
      "repo",
      run({
        databaseId: 700,
        source: "check",
        checkOutput: {
          title: null,
          summary: "Check failed with output only",
          text: null,
        },
        annotationsCount: 0,
      }),
    );
    expect(logs).toContain("Summary: Check failed with output only");
    // No API calls at all: output carried forward and no annotations.
    expect(mockExecFileSync).toHaveBeenCalledTimes(0);
  });

  test("returns fallback when check run detail fetch fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    // No carried-forward data → triggers a detail re-fetch which fails.
    const logs = collectFailureLogs(
      "org",
      "repo",
      run({ databaseId: 800, source: "check" }),
    );
    expect(logs).toBe("Unable to retrieve check run details.");
  });

  test("paginates annotations with --slurp and flattens pages", () => {
    // Simulate two pages of annotations as gh api --paginate --slurp
    // would return: an outer array containing one array per page.
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      path: `src/file${i}.ts`,
      start_line: i + 1,
      end_line: i + 1,
      annotation_level: "warning",
      message: `Issue ${i}`,
    }));
    const page2 = Array.from({ length: 50 }, (_, i) => ({
      path: `src/file${100 + i}.ts`,
      start_line: 100 + i + 1,
      end_line: 100 + i + 1,
      annotation_level: "warning",
      message: `Issue ${100 + i}`,
    }));

    // --slurp wraps pages into an outer array.
    mockExecFileSync.mockReturnValueOnce(JSON.stringify([page1, page2]));

    const logs = collectFailureLogs(
      "org",
      "repo",
      run({
        databaseId: 900,
        source: "check",
        checkOutput: {
          title: "150 issues found",
          summary: "Large scan result",
          text: null,
        },
        annotationsCount: 150,
      }),
    );

    // All 150 annotations from both pages should appear.
    expect(logs).toContain("file0.ts");
    expect(logs).toContain("file99.ts");
    expect(logs).toContain("file100.ts");
    expect(logs).toContain("file149.ts");
    expect(logs).toContain("Issue 0");
    expect(logs).toContain("Issue 149");

    // Verify --paginate --slurp was passed.
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gh",
      [
        "api",
        "--paginate",
        "--slurp",
        "repos/org/repo/check-runs/900/annotations?per_page=100",
      ],
      { encoding: "utf-8" },
    );
  });
});

// ---------------------------------------------------------------------------
// edge cases
// ---------------------------------------------------------------------------
describe("edge cases", () => {
  test("evaluateCiRuns with only pending runs → pending", () => {
    expect(
      evaluateCiRuns([
        run({ status: "queued" }),
        run({ status: "in_progress" }),
      ]),
    ).toBe("pending");
  });

  test("cancelled takes precedence over pending", () => {
    expect(
      evaluateCiRuns([
        run({ status: "in_progress" }),
        run({ conclusion: "cancelled" }),
      ]),
    ).toBe("fail");
  });

  test("getCiStatus with empty runs returns pass", () => {
    mockExecFileSync.mockReturnValue("[]");
    const status = getCiStatus("org", "repo", "main");
    expect(status.verdict).toBe("pass");
    expect(status.runs).toEqual([]);
  });

  test("normaliseCiConclusion handles null status", () => {
    const r = run({ status: undefined as unknown as string });
    expect(normaliseCiConclusion(r)).toBe("success");
  });

  test("normaliseCiConclusion handles null conclusion", () => {
    const r = run({ conclusion: undefined as unknown as string });
    expect(normaliseCiConclusion(r)).toBe("failure");
  });

  test("normaliseCiConclusion handles null status and conclusion", () => {
    const r = run({
      status: undefined as unknown as string,
      conclusion: undefined as unknown as string,
    });
    expect(normaliseCiConclusion(r)).toBe("failure");
  });

  test("fetchCiRuns returns empty array on malformed workflow JSON", () => {
    mockExecFileSync
      .mockReturnValueOnce("not json")
      .mockReturnValueOnce(JSON.stringify({ check_runs: [] }));
    expect(fetchCiRuns("org", "repo", "main")).toEqual([]);
  });

  test("fetchCiRuns throws on malformed check-runs JSON", () => {
    mockExecFileSync.mockReturnValueOnce("[]").mockReturnValueOnce("not json");
    expect(() => fetchCiRuns("org", "repo", "main")).toThrow();
  });
});
