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
  }> = {},
) {
  return {
    databaseId: 1,
    name: "CI",
    status: "completed",
    conclusion: "success",
    headBranch: "main",
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
  test("calls gh with correct arguments", () => {
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
        "databaseId,name,status,conclusion,headBranch",
        "--limit",
        "20",
      ],
      { encoding: "utf-8" },
    );
  });

  test("parses JSON output", () => {
    const runs = [run({ databaseId: 100, name: "build" })];
    mockExecFileSync.mockReturnValue(JSON.stringify(runs));
    expect(fetchCiRuns("org", "repo", "main")).toEqual(runs);
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
});

// ---------------------------------------------------------------------------
// collectFailureLogs
// ---------------------------------------------------------------------------
describe("collectFailureLogs", () => {
  test("calls gh run view with --log-failed", () => {
    mockExecFileSync.mockReturnValue("error log output");
    const logs = collectFailureLogs("org", "repo", 12345);
    expect(logs).toBe("error log output");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "gh",
      ["run", "view", "12345", "--repo", "org/repo", "--log-failed"],
      { encoding: "utf-8" },
    );
  });

  test("propagates error when gh command fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("run not found");
    });
    expect(() => collectFailureLogs("org", "repo", 999)).toThrow(
      "run not found",
    );
  });

  test("returns empty string when logs are empty", () => {
    mockExecFileSync.mockReturnValue("");
    expect(collectFailureLogs("org", "repo", 1)).toBe("");
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

  test("fetchCiRuns returns empty array on malformed JSON", () => {
    mockExecFileSync.mockReturnValue("not json");
    expect(fetchCiRuns("org", "repo", "main")).toEqual([]);
  });
});
