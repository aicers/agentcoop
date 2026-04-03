import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  openSync: vi.fn(),
  writeFileSync: vi.fn(),
  closeSync: vi.fn(),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const { withLock, repoLockPath } = await import("./lock.js");

const mockOpenSync = vi.mocked(openSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockCloseSync = vi.mocked(closeSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);

afterEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// repoLockPath
// ---------------------------------------------------------------------------
describe("repoLockPath", () => {
  test("returns lock file path next to bare repo", () => {
    expect(repoLockPath("aicers", "agentcoop")).toBe(
      join(homedir(), ".agentcoop", "repos", "aicers", "agentcoop.lock"),
    );
  });
});

// ---------------------------------------------------------------------------
// withLock
// ---------------------------------------------------------------------------
describe("withLock", () => {
  test("acquires lock, runs fn, and releases", () => {
    mockOpenSync.mockReturnValue(42 as never);
    const fn = vi.fn(() => "result");

    const result = withLock("/tmp/test.lock", fn);

    expect(result).toBe("result");
    expect(mockMkdirSync).toHaveBeenCalledWith("/tmp", { recursive: true });
    expect(mockOpenSync).toHaveBeenCalledWith("/tmp/test.lock", "wx");
    expect(mockWriteFileSync).toHaveBeenCalledWith(42, String(process.pid));
    expect(mockCloseSync).toHaveBeenCalledWith(42);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockUnlinkSync).toHaveBeenCalledWith("/tmp/test.lock");
  });

  test("releases lock when fn throws", () => {
    mockOpenSync.mockReturnValue(42 as never);
    const error = new Error("boom");

    expect(() =>
      withLock("/tmp/test.lock", () => {
        throw error;
      }),
    ).toThrow("boom");
    expect(mockUnlinkSync).toHaveBeenCalledWith("/tmp/test.lock");
  });

  test("removes stale lock and retries", () => {
    const eexist = Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    mockOpenSync
      .mockImplementationOnce(() => {
        throw eexist;
      })
      .mockReturnValue(42 as never);
    // Stale lock: PID that is not alive
    mockReadFileSync.mockReturnValue("999999999" as never);

    // Mock process.kill to indicate process is not alive
    const origKill = process.kill;
    process.kill = vi.fn(() => {
      throw new Error("ESRCH");
    }) as never;

    try {
      const result = withLock("/tmp/test.lock", () => "ok");
      expect(result).toBe("ok");
      expect(mockUnlinkSync).toHaveBeenCalled();
    } finally {
      process.kill = origKill;
    }
  });

  test("cleans up fd and lock file when writeFileSync throws", () => {
    mockOpenSync.mockReturnValue(42 as never);
    const writeErr = new Error("ENOSPC");
    mockWriteFileSync.mockImplementation(() => {
      throw writeErr;
    });

    expect(() => withLock("/tmp/test.lock", () => "ok")).toThrow("ENOSPC");
    expect(mockCloseSync).toHaveBeenCalledWith(42);
    expect(mockUnlinkSync).toHaveBeenCalledWith("/tmp/test.lock");
  });

  test("cleans up lock file when closeSync throws", () => {
    mockOpenSync.mockReturnValue(42 as never);
    const closeErr = new Error("EIO");
    mockCloseSync.mockImplementation(() => {
      throw closeErr;
    });

    expect(() => withLock("/tmp/test.lock", () => "ok")).toThrow("EIO");
    expect(mockUnlinkSync).toHaveBeenCalledWith("/tmp/test.lock");
  });

  test("propagates non-EEXIST errors from open", () => {
    const eperm = Object.assign(new Error("EPERM"), { code: "EPERM" });
    mockOpenSync.mockImplementation(() => {
      throw eperm;
    });

    expect(() => withLock("/tmp/test.lock", () => "ok")).toThrow("EPERM");
  });
});
