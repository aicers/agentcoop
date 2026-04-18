import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createBootstrapLog } from "./bootstrap-log.js";

describe("createBootstrapLog", () => {
  const stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const stderrSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  beforeEach(() => {
    stdoutSpy.mockClear();
    stderrSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("log() prints to stdout and records a timestamped entry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T09:08:07Z"));
    const log = createBootstrapLog();

    log.log("Bootstrapping repository...");

    expect(stdoutSpy).toHaveBeenCalledWith("Bootstrapping repository...");
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].message).toBe("Bootstrapping repository...");
    // Timestamp is HH:MM:SS in local time; assert format shape only.
    expect(log.entries[0].timestamp).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  test("warn() prints to stderr and records a timestamped entry", () => {
    const log = createBootstrapLog();

    log.warn("Uncommitted changes preserved");

    expect(stderrSpy).toHaveBeenCalledWith("Uncommitted changes preserved");
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].message).toBe("Uncommitted changes preserved");
  });

  test("preserves emission order across log and warn calls", () => {
    const log = createBootstrapLog();

    log.log("first");
    log.warn("second");
    log.log("third");

    expect(log.entries.map((e) => e.message)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});
