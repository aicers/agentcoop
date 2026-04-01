import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const { findPrNumber } = await import("./pr.js");

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
