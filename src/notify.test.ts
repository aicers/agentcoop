import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest";
import type { NotificationSettings } from "./config.js";

// Mock child_process.execFile before importing the module under test.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Mock i18n — provide a minimal catalog with notification.title.
vi.mock("./i18n/index.js", () => ({
  t: () => ({ "notification.title": "agentcoop" }),
}));

const { execFile } = await import("node:child_process");
const { notifyInputWaiting, _emitBell, _sendDesktop } = await import(
  "./notify.js"
);

describe("notifyInputWaiting", () => {
  let stdoutWriteSpy: MockInstance;

  beforeEach(() => {
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.mocked(execFile).mockReset();
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
  });

  test("fires bell when bell is enabled", () => {
    const settings: NotificationSettings = { bell: true, desktop: false };
    notifyInputWaiting(settings, "Ready?");
    expect(stdoutWriteSpy).toHaveBeenCalledWith("\x07");
    expect(execFile).not.toHaveBeenCalled();
  });

  test("fires desktop notification when desktop is enabled (darwin)", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const settings: NotificationSettings = { bell: false, desktop: true };
      notifyInputWaiting(settings, "Ready?");
      expect(stdoutWriteSpy).not.toHaveBeenCalled();
      expect(execFile).toHaveBeenCalledWith("osascript", [
        "-e",
        'display notification "Ready?" with title "agentcoop"',
      ]);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  test("fires desktop notification when desktop is enabled (linux)", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const settings: NotificationSettings = { bell: false, desktop: true };
      notifyInputWaiting(settings, "Ready?");
      expect(execFile).toHaveBeenCalledWith("notify-send", [
        "agentcoop",
        "Ready?",
      ]);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  test("fires both bell and desktop when both enabled", () => {
    const settings: NotificationSettings = { bell: true, desktop: true };
    notifyInputWaiting(settings, "Proceed?");
    expect(stdoutWriteSpy).toHaveBeenCalledWith("\x07");
    expect(execFile).toHaveBeenCalled();
  });

  test("fires nothing when both disabled", () => {
    const settings: NotificationSettings = { bell: false, desktop: false };
    notifyInputWaiting(settings, "Hello");
    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  test("bell silently handles stdout write failure", () => {
    stdoutWriteSpy.mockImplementation(() => {
      throw new Error("stdout broken");
    });
    // Should not throw.
    expect(() => _emitBell()).not.toThrow();
  });

  test("desktop notification silently handles execFile failure", () => {
    vi.mocked(execFile).mockImplementation(() => {
      throw new Error("command not found");
    });
    // Should not throw.
    expect(() => _sendDesktop("test message")).not.toThrow();
  });

  test("escapes double quotes in desktop notification message (darwin)", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const settings: NotificationSettings = { bell: false, desktop: true };
      notifyInputWaiting(settings, 'Stage "Done" ready');
      expect(execFile).toHaveBeenCalledWith("osascript", [
        "-e",
        'display notification "Stage \\"Done\\" ready" with title "agentcoop"',
      ]);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  test("skips desktop notification on unsupported platform", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const settings: NotificationSettings = { bell: false, desktop: true };
      notifyInputWaiting(settings, "Ready?");
      expect(execFile).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  test("escapes backslashes in desktop notification message (darwin)", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const settings: NotificationSettings = { bell: false, desktop: true };
      notifyInputWaiting(settings, "path\\to\\file");
      expect(execFile).toHaveBeenCalledWith("osascript", [
        "-e",
        'display notification "path\\\\to\\\\file" with title "agentcoop"',
      ]);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});
