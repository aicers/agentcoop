import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import {
  closePr,
  deleteRemoteBranch,
  hasDockerComposeFile,
  hasDockerComposeRunning,
  remoteBranchExists,
  stopDockerCompose,
} from "./cleanup.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

const mockExec = vi.mocked(execFileSync);
const mockExists = vi.mocked(existsSync);

describe("hasDockerComposeFile", () => {
  test("returns true when docker-compose.yml exists", () => {
    mockExists.mockImplementation((path) =>
      String(path).endsWith("docker-compose.yml"),
    );
    expect(hasDockerComposeFile("/tmp/wt")).toBe(true);
  });

  test("returns true when compose.yaml exists", () => {
    mockExists.mockImplementation((path) =>
      String(path).endsWith("compose.yaml"),
    );
    expect(hasDockerComposeFile("/tmp/wt")).toBe(true);
  });

  test("returns false when no compose file exists", () => {
    mockExists.mockReturnValue(false);
    expect(hasDockerComposeFile("/tmp/wt")).toBe(false);
  });
});

describe("hasDockerComposeRunning", () => {
  test("returns false when no compose file exists", () => {
    mockExists.mockReturnValue(false);
    expect(hasDockerComposeRunning("/tmp/wt")).toBe(false);
  });

  test("returns true when services are running", () => {
    mockExists.mockReturnValue(true);
    mockExec.mockReturnValue("abc123\n" as never);
    expect(hasDockerComposeRunning("/tmp/wt")).toBe(true);
  });

  test("returns false when no services are running", () => {
    mockExists.mockReturnValue(true);
    mockExec.mockReturnValue("" as never);
    expect(hasDockerComposeRunning("/tmp/wt")).toBe(false);
  });

  test("returns false when docker command fails", () => {
    mockExists.mockReturnValue(true);
    mockExec.mockImplementation(() => {
      throw new Error("docker not found");
    });
    expect(hasDockerComposeRunning("/tmp/wt")).toBe(false);
  });
});

describe("stopDockerCompose", () => {
  test("runs docker compose down", () => {
    mockExec.mockReturnValue("" as never);
    stopDockerCompose("/tmp/wt");
    expect(mockExec).toHaveBeenCalledWith(
      "docker",
      ["compose", "down"],
      expect.objectContaining({ cwd: "/tmp/wt" }),
    );
  });

  test("does not throw when docker command fails", () => {
    mockExec.mockImplementation(() => {
      throw new Error("docker not found");
    });
    expect(() => stopDockerCompose("/tmp/wt")).not.toThrow();
  });
});

describe("remoteBranchExists", () => {
  test("returns true when API call succeeds", () => {
    mockExec.mockReturnValue("" as never);
    expect(remoteBranchExists("owner", "repo", "my-branch")).toBe(true);
  });

  test("returns false when API call fails", () => {
    mockExec.mockImplementation(() => {
      throw new Error("Not Found");
    });
    expect(remoteBranchExists("owner", "repo", "my-branch")).toBe(false);
  });
});

describe("deleteRemoteBranch", () => {
  test("calls gh api to delete the branch ref", () => {
    mockExec.mockReturnValue("" as never);
    deleteRemoteBranch("owner", "repo", "my-branch");
    expect(mockExec).toHaveBeenCalledWith(
      "gh",
      ["api", "-X", "DELETE", "repos/owner/repo/git/refs/heads/my-branch"],
      expect.any(Object),
    );
  });
});

describe("closePr", () => {
  test("calls gh pr close with correct arguments", () => {
    mockExec.mockReturnValue("" as never);
    closePr("owner", "repo", 42);
    expect(mockExec).toHaveBeenCalledWith(
      "gh",
      ["pr", "close", "42", "--repo", "owner/repo"],
      expect.any(Object),
    );
  });
});
