import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
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
  statSync: vi.fn(),
}));

const { withLock, repoLockPath } = await import("./lock.js");

const mockOpenSync = vi.mocked(openSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockCloseSync = vi.mocked(closeSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockStatSync = vi.mocked(statSync);

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
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      42,
      expect.stringMatching(new RegExp(`^${process.pid}:\\d+$`)),
    );
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
    // Stale lock: PID that is not alive, in pid:timestamp format
    mockReadFileSync.mockReturnValue("999999999:1700000000000" as never);

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

  test("treats empty lock file as stale and retries when old", () => {
    const eexist = Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    mockOpenSync
      .mockImplementationOnce(() => {
        throw eexist;
      })
      .mockReturnValue(42 as never);
    // Empty lock file — e.g. process killed between openSync and writeFileSync
    mockReadFileSync.mockReturnValue("" as never);
    // File is old (10 seconds ago) — safe to treat as stale
    mockStatSync.mockReturnValue({ ctimeMs: Date.now() - 10_000 } as never);

    const result = withLock("/tmp/test.lock", () => "ok");
    expect(result).toBe("ok");
    // Stale lock removed, then new lock acquired and released
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  test("treats non-numeric lock file as stale and retries when old", () => {
    const eexist = Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    mockOpenSync
      .mockImplementationOnce(() => {
        throw eexist;
      })
      .mockReturnValue(42 as never);
    // Truncated/corrupt lock file contents
    mockReadFileSync.mockReturnValue("garbage" as never);
    mockStatSync.mockReturnValue({ ctimeMs: Date.now() - 10_000 } as never);

    const result = withLock("/tmp/test.lock", () => "ok");
    expect(result).toBe("ok");
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  test("treats partially numeric lock file as stale and retries when old", () => {
    const eexist = Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    mockOpenSync
      .mockImplementationOnce(() => {
        throw eexist;
      })
      .mockReturnValue(42 as never);
    // Truncated PID — e.g. original was "12345" but only "12" was written
    mockReadFileSync.mockReturnValue("12garbage" as never);
    mockStatSync.mockReturnValue({ ctimeMs: Date.now() - 10_000 } as never);

    const result = withLock("/tmp/test.lock", () => "ok");
    expect(result).toBe("ok");
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  test("treats pure-digit truncated PID as stale and retries when old", () => {
    const eexist = Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    mockOpenSync
      .mockImplementationOnce(() => {
        throw eexist;
      })
      .mockReturnValue(42 as never);
    // Pure-digit truncation — e.g. original was "12345:1700000000000"
    // but only "12345" was written before the process was killed.
    mockReadFileSync.mockReturnValue("12345" as never);
    mockStatSync.mockReturnValue({ ctimeMs: Date.now() - 10_000 } as never);

    const result = withLock("/tmp/test.lock", () => "ok");
    expect(result).toBe("ok");
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  test("preserves young malformed lock file instead of deleting it", () => {
    const eexist = Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    let attempt = 0;
    mockOpenSync.mockImplementation(() => {
      attempt++;
      // First two attempts: EEXIST (file is being initialised)
      // Third attempt: lock acquired
      if (attempt <= 2) throw eexist;
      return 42 as never;
    });
    // First read: empty (mid-initialisation), second read: valid owner
    mockReadFileSync
      .mockReturnValueOnce("" as never)
      .mockReturnValueOnce(`${process.pid}:${Date.now()}` as never);
    // File is young (just created 100ms ago) — must NOT delete
    mockStatSync.mockReturnValue({ ctimeMs: Date.now() - 100 } as never);

    // Mock process.kill to indicate our own PID is alive
    const origKill = process.kill;
    process.kill = vi.fn(() => true) as never;

    try {
      const result = withLock("/tmp/test.lock", () => "ok");
      expect(result).toBe("ok");
      // The young empty file must not have been deleted (unlinkSync
      // is only called once — at the end, for the release).
      const unlinkCalls = mockUnlinkSync.mock.calls.filter(
        (c) => c[0] === "/tmp/test.lock",
      );
      expect(unlinkCalls).toHaveLength(1); // release only
    } finally {
      process.kill = origKill;
    }
  });

  test("propagates non-EEXIST errors from open", () => {
    const eperm = Object.assign(new Error("EPERM"), { code: "EPERM" });
    mockOpenSync.mockImplementation(() => {
      throw eperm;
    });

    expect(() => withLock("/tmp/test.lock", () => "ok")).toThrow("EPERM");
  });
});
