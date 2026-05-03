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
  collectFindings,
  fetchCodeScanningAlerts,
  correlateFindings,
  dismissCodeScanningAlert,
  buildCiInspectionContext,
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
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  test("parses JSON output", () => {
    const runs = [run({ databaseId: 100, name: "build" })];
    mockExecFileSync.mockReturnValue(JSON.stringify(runs));
    const result = fetchCiRuns("org", "repo", "main");
    expect(result.runs).toEqual(runs);
    expect(result.runsIncomplete).toBe(false);
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
      expect.objectContaining({ encoding: "utf-8" }),
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
    expect(result.runs).toHaveLength(2);
    expect(result.runs[0]).toEqual(
      expect.objectContaining({
        databaseId: 1,
        name: "CI",
        source: "workflow",
      }),
    );
    expect(result.runs[1]).toEqual(
      expect.objectContaining({
        databaseId: 500,
        name: "CodeQL",
        source: "check",
        conclusion: "failure",
        checkOutput: { title: null, summary: null, text: null },
        annotationsCount: 0,
      }),
    );
    expect(result.runsIncomplete).toBe(false);
  });

  test("uses commitSha as ref for check runs API", () => {
    mockExecFileSync
      .mockReturnValueOnce("[]")
      .mockReturnValueOnce(JSON.stringify({ check_runs: [] }));

    fetchCiRuns("org", "repo", "main", "deadbeef");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gh",
      ["api", "repos/org/repo/commits/deadbeef/check-runs?per_page=100"],
      expect.objectContaining({ encoding: "utf-8" }),
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
      expect.objectContaining({ encoding: "utf-8" }),
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
      expect.objectContaining({ encoding: "utf-8" }),
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
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].name).toBe("External check");
  });

  test("flags runsIncomplete when check-run total_count exceeds first page", () => {
    // First page returns 100 entries with total_count = 150.
    const entries = Array.from({ length: 100 }, (_, i) => ({
      id: 1000 + i,
      name: `check-${i}`,
      status: "completed",
      conclusion: "success",
      head_sha: "abc",
      output: { title: null, summary: null, text: null },
      annotations_count: 0,
      app: { slug: "external" },
    }));
    const response = { total_count: 150, check_runs: entries };

    mockExecFileSync
      .mockReturnValueOnce("[]")
      .mockReturnValueOnce(JSON.stringify(response));

    const result = fetchCiRuns("org", "repo", "main");
    expect(result.runs).toHaveLength(100);
    expect(result.runsIncomplete).toBe(true);
  });

  test("flags runsIncomplete when workflow runs page is full", () => {
    const workflowRuns = Array.from({ length: 100 }, (_, i) => ({
      databaseId: 5000 + i,
      name: `workflow-${i}`,
      status: "completed",
      conclusion: "success",
      headBranch: "main",
      headSha: "abc",
    }));

    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(workflowRuns))
      .mockReturnValueOnce(JSON.stringify({ total_count: 0, check_runs: [] }));

    const result = fetchCiRuns("org", "repo", "main");
    expect(result.runs).toHaveLength(100);
    expect(result.runsIncomplete).toBe(true);
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
    const status = getCiStatus("org", "repo", "main");
    expect(status.verdict).toBe("fail");
  });

  test("returns pending verdict for in-progress runs", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify([run({ status: "in_progress" })]),
    );
    const status = getCiStatus("org", "repo", "main");
    expect(status.verdict).toBe("pending");
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

  test("does not pre-fetch annotations during status read", () => {
    // The new pointer-based design must not pull annotation bodies
    // during `getCiStatus` — that work is delegated to the agent.
    const checkRunsResponse = {
      check_runs: [
        {
          id: 800,
          name: "Linter",
          status: "completed",
          conclusion: "success",
          head_sha: "abc123",
          output: { title: null, summary: null, text: null },
          annotations_count: 2,
          app: { slug: "some-linter" },
        },
      ],
    };

    mockExecFileSync
      .mockReturnValueOnce("[]")
      .mockReturnValueOnce(JSON.stringify(checkRunsResponse));

    const status = getCiStatus("org", "repo", "main");
    expect(status.verdict).toBe("pass");
    // Exactly two gh calls: workflow list + check runs list.  No
    // annotations fetch is triggered.
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    const calls = mockExecFileSync.mock.calls.map((c) =>
      (c[1] as string[]).join(" "),
    );
    expect(calls.some((c) => c.includes("/annotations"))).toBe(false);
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
      expect.objectContaining({ encoding: "utf-8" }),
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
      expect.objectContaining({ encoding: "utf-8" }),
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
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });
});

// ---------------------------------------------------------------------------
// collectFindings
// ---------------------------------------------------------------------------
describe("collectFindings", () => {
  test("returns empty findings for workflow-only runs", () => {
    const runs = [run({ source: "workflow" })];
    const result = collectFindings("org", "repo", runs);
    expect(result.findings).toEqual([]);
    expect(result.incomplete).toBe(false);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  test("returns empty findings when annotationsCount is 0", () => {
    const runs = [
      run({ source: "check", annotationsCount: 0, databaseId: 100 }),
    ];
    const result = collectFindings("org", "repo", runs);
    expect(result.findings).toEqual([]);
    expect(result.incomplete).toBe(false);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  test("collects findings from check run with annotations", () => {
    const annotations = [
      {
        path: "src/app.ts",
        start_line: 10,
        end_line: 10,
        annotation_level: "warning",
        message: "Unused variable",
        title: "no-unused-vars",
      },
      {
        path: "src/util.ts",
        start_line: 25,
        end_line: 25,
        annotation_level: "notice",
        message: "Consider simplifying",
      },
    ];

    mockExecFileSync.mockReturnValueOnce(JSON.stringify([annotations]));

    const runs = [
      run({
        databaseId: 500,
        name: "ESLint",
        source: "check",
        annotationsCount: 2,
      }),
    ];
    const result = collectFindings("org", "repo", runs);

    expect(result.findings).toHaveLength(2);
    expect(result.incomplete).toBe(false);
    expect(result.findings[0]).toEqual({
      level: "warning",
      message: "Unused variable",
      file: "src/app.ts",
      line: 10,
      rule: "no-unused-vars",
      checkRunId: 500,
      checkRunName: "ESLint",
      commitSha: "abc123",
    });
    expect(result.findings[1]).toEqual({
      level: "notice",
      message: "Consider simplifying",
      file: "src/util.ts",
      line: 25,
      rule: undefined,
      checkRunId: 500,
      checkRunName: "ESLint",
      commitSha: "abc123",
    });
  });

  test("sets incomplete flag when annotation fetch fails", () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("API error");
    });

    const runs = [
      run({ databaseId: 600, source: "check", annotationsCount: 1 }),
    ];
    const result = collectFindings("org", "repo", runs);
    expect(result.findings).toEqual([]);
    expect(result.incomplete).toBe(true);
  });

  test("skips workflow runs and collects from check runs only", () => {
    const annotations = [
      {
        path: "src/index.ts",
        start_line: 1,
        end_line: 1,
        annotation_level: "warning",
        message: "Missing return type",
        title: "explicit-return-type",
      },
    ];

    mockExecFileSync.mockReturnValueOnce(JSON.stringify([annotations]));

    const runs = [
      run({ databaseId: 1, source: "workflow" }),
      run({
        databaseId: 700,
        name: "TypeCheck",
        source: "check",
        annotationsCount: 1,
      }),
    ];
    const result = collectFindings("org", "repo", runs);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].checkRunId).toBe(700);
    expect(result.incomplete).toBe(false);
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

  test("getCiStatus with empty runs returns pass with empty runs", () => {
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

  test("fetchCiRuns returns empty runs on malformed workflow JSON", () => {
    mockExecFileSync
      .mockReturnValueOnce("not json")
      .mockReturnValueOnce(JSON.stringify({ check_runs: [] }));
    const result = fetchCiRuns("org", "repo", "main");
    expect(result.runs).toEqual([]);
    expect(result.runsIncomplete).toBe(false);
  });

  test("fetchCiRuns throws on malformed check-runs JSON", () => {
    mockExecFileSync.mockReturnValueOnce("[]").mockReturnValueOnce("not json");
    expect(() => fetchCiRuns("org", "repo", "main")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// fetchCodeScanningAlerts
// ---------------------------------------------------------------------------
describe("fetchCodeScanningAlerts", () => {
  test("fetches and flattens paginated alerts", () => {
    const alerts = [
      {
        number: 1,
        rule: { id: "js/sql-injection" },
        tool: { name: "CodeQL" },
        most_recent_instance: {
          location: { path: "src/db.ts", start_line: 42 },
          commit_sha: "abc123",
        },
        state: "open",
        html_url: "https://github.com/org/repo/security/code-scanning/1",
      },
    ];
    mockExecFileSync.mockReturnValueOnce(JSON.stringify([alerts]));

    const result = fetchCodeScanningAlerts("org", "repo", "my-branch");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
    expect(result[0].rule.id).toBe("js/sql-injection");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gh",
      [
        "api",
        "--paginate",
        "--slurp",
        "repos/org/repo/code-scanning/alerts?ref=my-branch&state=open&per_page=100",
      ],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  test("URL-encodes ref containing slashes", () => {
    mockExecFileSync.mockReturnValueOnce(JSON.stringify([[]]));
    fetchCodeScanningAlerts("org", "repo", "user/issue-42");
    const args = mockExecFileSync.mock.calls[0][1] as string[];
    expect(args[3]).toContain("ref=user%2Fissue-42");
  });

  test("returns empty array on API error", () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("404 Not Found");
    });
    const result = fetchCodeScanningAlerts("org", "repo", "main");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// correlateFindings
// ---------------------------------------------------------------------------
describe("correlateFindings", () => {
  const makeAlert = (
    overrides: Partial<{
      number: number;
      ruleId: string;
      toolName: string;
      path: string;
      startLine: number;
      commitSha: string;
      htmlUrl: string;
    }> = {},
  ) => ({
    number: overrides.number ?? 1,
    rule: { id: overrides.ruleId ?? "js/sql-injection" },
    tool: { name: overrides.toolName ?? "CodeQL" },
    most_recent_instance: {
      location: {
        path: overrides.path ?? "src/db.ts",
        start_line: overrides.startLine ?? 42,
      },
      commit_sha: overrides.commitSha ?? "abc123",
    },
    state: "open" as const,
    html_url:
      overrides.htmlUrl ??
      "https://github.com/org/repo/security/code-scanning/1",
  });

  const makeFinding = (
    overrides: Partial<{
      rule: string;
      checkRunName: string;
      file: string;
      line: number;
      commitSha: string;
    }> = {},
  ) => ({
    level: "warning",
    message: "SQL injection vulnerability",
    file: overrides.file ?? "src/db.ts",
    line: overrides.line ?? 42,
    rule: overrides.rule ?? "js/sql-injection",
    checkRunId: 500,
    checkRunName: overrides.checkRunName ?? "CodeQL",
    commitSha: overrides.commitSha ?? "abc123",
  });

  test("matches finding to alert on all five fields", () => {
    const findings = [makeFinding()];
    const alerts = [makeAlert()];
    const result = correlateFindings(findings, alerts);

    expect(result).toHaveLength(1);
    expect(result[0].alertNumber).toBe(1);
    expect(result[0].alertUrl).toContain("code-scanning/1");
    expect(result[0].finding).toBe(findings[0]);
  });

  test("requires exact SHA match — mismatched SHA yields no alert", () => {
    const findings = [makeFinding({ commitSha: "new-sha" })];
    const alerts = [makeAlert({ commitSha: "old-sha" })];
    const result = correlateFindings(findings, alerts);

    expect(result).toHaveLength(1);
    expect(result[0].alertNumber).toBeUndefined();
  });

  test("returns undefined alertNumber when no match", () => {
    const findings = [makeFinding({ rule: "js/xss" })];
    const alerts = [makeAlert({ ruleId: "js/sql-injection" })];
    const result = correlateFindings(findings, alerts);

    expect(result).toHaveLength(1);
    expect(result[0].alertNumber).toBeUndefined();
    expect(result[0].alertUrl).toBeUndefined();
  });

  test("handles multiple findings with mixed matches", () => {
    const findings = [
      makeFinding({ rule: "js/sql-injection", file: "src/db.ts", line: 42 }),
      makeFinding({ rule: "js/xss", file: "src/ui.ts", line: 10 }),
    ];
    const alerts = [
      makeAlert({
        number: 1,
        ruleId: "js/sql-injection",
        path: "src/db.ts",
        startLine: 42,
      }),
    ];
    const result = correlateFindings(findings, alerts);

    expect(result).toHaveLength(2);
    expect(result[0].alertNumber).toBe(1);
    expect(result[1].alertNumber).toBeUndefined();
  });

  test("matches correct alert among multiple alerts", () => {
    const findings = [makeFinding({ rule: "js/xss", file: "src/ui.ts" })];
    const alerts = [
      makeAlert({
        number: 1,
        ruleId: "js/sql-injection",
        path: "src/db.ts",
      }),
      makeAlert({
        number: 2,
        ruleId: "js/xss",
        toolName: "CodeQL",
        path: "src/ui.ts",
        startLine: 42,
      }),
    ];
    const result = correlateFindings(findings, alerts);

    expect(result[0].alertNumber).toBe(2);
  });

  test("handles findings with no rule gracefully", () => {
    const findings = [makeFinding({ rule: undefined as unknown as string })];
    // Override: the finding's rule field is undefined.
    findings[0].rule = undefined;
    const alerts = [makeAlert({ ruleId: "" })];
    const result = correlateFindings(findings, alerts);

    // Should match: undefined rule maps to "" which matches alert's "".
    expect(result[0].alertNumber).toBe(1);
  });

  test("returns empty array for empty inputs", () => {
    expect(correlateFindings([], [])).toEqual([]);
    expect(correlateFindings([], [makeAlert()])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// dismissCodeScanningAlert
// ---------------------------------------------------------------------------
describe("dismissCodeScanningAlert", () => {
  test("calls gh api with correct PATCH arguments", () => {
    mockExecFileSync.mockReturnValueOnce("{}");
    dismissCodeScanningAlert("org", "repo", 42, "Test-only code");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gh",
      [
        "api",
        "-X",
        "PATCH",
        "repos/org/repo/code-scanning/alerts/42",
        "-f",
        "state=dismissed",
        "-f",
        "dismissed_reason=false positive",
        "-f",
        "dismissed_comment=Test-only code",
      ],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  test("propagates API error", () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("403 Forbidden");
    });
    expect(() => dismissCodeScanningAlert("org", "repo", 42, "reason")).toThrow(
      "403 Forbidden",
    );
  });
});

// ---------------------------------------------------------------------------
// buildCiInspectionContext
// ---------------------------------------------------------------------------
describe("buildCiInspectionContext", () => {
  test("returns empty context for an empty status", () => {
    const ctx = buildCiInspectionContext("org", "repo", "main", {
      verdict: "pass",
      runs: [],
    });
    expect(ctx).toEqual({
      workflowRuns: [],
      checkRunIds: [],
      hasAnnotations: false,
      annotationsIncomplete: false,
      ref: "main",
    });
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  test("does not fetch jobs for successful workflow runs", () => {
    const ctx = buildCiInspectionContext("org", "repo", "main", {
      verdict: "pass",
      runs: [run({ databaseId: 100 })],
    });
    expect(ctx.workflowRuns).toEqual([]);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  test("fetches one bounded jobs page per failing workflow run", () => {
    const jobsResponse = {
      total_count: 2,
      jobs: [
        {
          id: 555,
          name: "build (ubuntu-latest, node 20)",
          status: "completed",
          conclusion: "failure",
        },
        {
          id: 556,
          name: "lint",
          status: "completed",
          conclusion: "success",
        },
      ],
    };
    mockExecFileSync.mockReturnValueOnce(JSON.stringify(jobsResponse));

    const ctx = buildCiInspectionContext("org", "repo", "abc123", {
      verdict: "fail",
      runs: [
        run({ databaseId: 100, conclusion: "failure", source: "workflow" }),
      ],
    });

    expect(ctx.workflowRuns).toEqual([
      {
        runId: 100,
        failedJobs: [{ id: 555, name: "build (ubuntu-latest, node 20)" }],
      },
    ]);
    expect(ctx.annotationsIncomplete).toBe(false);
    // Verify the bounded API call (no `--paginate`).
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gh",
      ["api", "repos/org/repo/actions/runs/100/jobs?per_page=100"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  test("flags annotationsIncomplete when jobs fetch fails", () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("API error");
    });

    const ctx = buildCiInspectionContext("org", "repo", "abc", {
      verdict: "fail",
      runs: [run({ databaseId: 200, conclusion: "failure" })],
    });

    expect(ctx.workflowRuns).toEqual([{ runId: 200, failedJobs: [] }]);
    expect(ctx.annotationsIncomplete).toBe(true);
  });

  test("flags annotationsIncomplete when jobs page is at cap", () => {
    const jobsResponse = {
      total_count: 250,
      jobs: Array.from({ length: 100 }, (_, i) => ({
        id: 1000 + i,
        name: `job-${i}`,
        status: "completed",
        conclusion: i === 0 ? "failure" : "success",
      })),
    };
    mockExecFileSync.mockReturnValueOnce(JSON.stringify(jobsResponse));

    const ctx = buildCiInspectionContext("org", "repo", "abc", {
      verdict: "fail",
      runs: [run({ databaseId: 300, conclusion: "failure" })],
    });

    expect(ctx.annotationsIncomplete).toBe(true);
    expect(ctx.workflowRuns[0].failedJobs).toHaveLength(1);
  });

  test("collects failing check run IDs and annotation hint", () => {
    const ctx = buildCiInspectionContext("org", "repo", "abc", {
      verdict: "fail",
      runs: [
        run({
          databaseId: 500,
          source: "check",
          conclusion: "failure",
          annotationsCount: 3,
        }),
        run({
          databaseId: 501,
          source: "check",
          conclusion: "success",
          annotationsCount: 0,
        }),
      ],
    });

    expect(ctx.checkRunIds).toEqual([500]);
    expect(ctx.hasAnnotations).toBe(true);
  });

  test("includes annotated passing check runs in checkRunIds", () => {
    const ctx = buildCiInspectionContext("org", "repo", "abc", {
      verdict: "pass",
      runs: [
        run({
          databaseId: 600,
          source: "check",
          conclusion: "success",
          annotationsCount: 5,
        }),
      ],
    });

    expect(ctx.checkRunIds).toEqual([600]);
    expect(ctx.hasAnnotations).toBe(true);
    expect(ctx.workflowRuns).toEqual([]);
  });

  test("propagates ciStatus.runsIncomplete to annotationsIncomplete", () => {
    // No `gh api .../jobs` call needed because runs is empty — the
    // helper should still surface the truncation flag from the
    // upstream listing.
    const ctx = buildCiInspectionContext("org", "repo", "abc", {
      verdict: "pass",
      runs: [],
      runsIncomplete: true,
    });

    expect(ctx.annotationsIncomplete).toBe(true);
    // Truncation also implies "annotations may exist on a later
    // page" so the findings-review path stays engaged.
    expect(ctx.hasAnnotations).toBe(true);
  });

  test("never reaches gh run view --log-failed", () => {
    // Regression guard: the helper must not pull raw step logs.
    mockExecFileSync.mockReturnValueOnce(
      JSON.stringify({ total_count: 1, jobs: [] }),
    );
    buildCiInspectionContext("org", "repo", "abc", {
      verdict: "fail",
      runs: [run({ databaseId: 999, conclusion: "failure" })],
    });
    const calls = mockExecFileSync.mock.calls.map((c) =>
      (c[1] as string[]).join(" "),
    );
    expect(
      calls.some((c) => c.includes("--log-failed") || c.includes("run view")),
    ).toBe(false);
    expect(calls.some((c) => c.includes("/code-scanning/alerts"))).toBe(false);
    expect(calls.some((c) => c.includes("/annotations"))).toBe(false);
  });
});
