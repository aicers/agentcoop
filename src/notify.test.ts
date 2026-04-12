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

// Mock child_process before importing the module under test.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Mock i18n — provide a minimal catalog with notification.title.
vi.mock("./i18n/index.js", () => ({
  t: () => ({ "notification.title": "agentcoop" }),
}));

const { execFile } = await import("node:child_process");
const {
  notifyInputWaiting,
  _emitBell,
  _sendDesktop,
  _detectNotifier,
  _sanitizeOscPayload,
  _findTmuxOuterTerminal,
  _probeTmuxPassthrough,
} = await import("./notify.js");

const ENV_KEYS = ["CMUX_SOCKET_PATH", "TMUX", "TERM_PROGRAM"] as const;

describe("notifyInputWaiting", () => {
  let stdoutWriteSpy: MockInstance;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.mocked(execFile).mockReset();
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  test("fires bell when bell is enabled", () => {
    const settings: NotificationSettings = {
      bell: true,
      desktop: false,
    };
    notifyInputWaiting(settings, "Ready?");
    expect(stdoutWriteSpy).toHaveBeenCalledWith("\x07");
    expect(execFile).not.toHaveBeenCalled();
  });

  test("fires desktop notification when desktop is enabled (darwin)", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const settings: NotificationSettings = {
        bell: false,
        desktop: true,
      };
      notifyInputWaiting(settings, "Ready?");
      expect(stdoutWriteSpy).not.toHaveBeenCalled();
      expect(execFile).toHaveBeenCalledWith("osascript", [
        "-e",
        'display notification "Ready?" with title "agentcoop"',
      ]);
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
      });
    }
  });

  test("fires desktop notification when desktop is enabled (linux)", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const settings: NotificationSettings = {
        bell: false,
        desktop: true,
      };
      notifyInputWaiting(settings, "Ready?");
      expect(execFile).toHaveBeenCalledWith("notify-send", [
        "agentcoop",
        "Ready?",
      ]);
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
      });
    }
  });

  test("fires both bell and desktop when both enabled", () => {
    const settings: NotificationSettings = {
      bell: true,
      desktop: true,
    };
    notifyInputWaiting(settings, "Proceed?");
    expect(stdoutWriteSpy).toHaveBeenCalledWith("\x07");
    expect(execFile).toHaveBeenCalled();
  });

  test("fires nothing when both disabled", () => {
    const settings: NotificationSettings = {
      bell: false,
      desktop: false,
    };
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

  test("desktop notification silently handles execFile failure", async () => {
    vi.mocked(execFile).mockImplementation(() => {
      throw new Error("command not found");
    });
    // Should not reject — outer try/catch swallows.
    await _sendDesktop("test message");
  });

  test("escapes double quotes in desktop notification message (darwin)", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const settings: NotificationSettings = {
        bell: false,
        desktop: true,
      };
      notifyInputWaiting(settings, 'Stage "Done" ready');
      expect(execFile).toHaveBeenCalledWith("osascript", [
        "-e",
        'display notification "Stage \\"Done\\" ready" with title "agentcoop"',
      ]);
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
      });
    }
  });

  test("skips desktop notification on unsupported platform", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const settings: NotificationSettings = {
        bell: false,
        desktop: true,
      };
      notifyInputWaiting(settings, "Ready?");
      expect(execFile).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
      });
    }
  });

  test("escapes backslashes in desktop notification message (darwin)", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const settings: NotificationSettings = {
        bell: false,
        desktop: true,
      };
      notifyInputWaiting(settings, "path\\to\\file");
      expect(execFile).toHaveBeenCalledWith("osascript", [
        "-e",
        'display notification "path\\\\to\\\\file" with title "agentcoop"',
      ]);
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
      });
    }
  });
});

describe("detectNotifier", () => {
  test("returns notify-send on linux", () => {
    expect(_detectNotifier({}, "linux")).toBe("notify-send");
  });

  test("returns none on unsupported platform", () => {
    expect(_detectNotifier({}, "win32")).toBe("none");
  });

  test("returns cmux when CMUX_SOCKET_PATH is set", () => {
    expect(
      _detectNotifier({ CMUX_SOCKET_PATH: "/tmp/cmux.sock" }, "darwin"),
    ).toBe("cmux");
  });

  test("returns tmux when TMUX is set", () => {
    expect(
      _detectNotifier({ TMUX: "/tmp/tmux-1000/default,1234,0" }, "darwin"),
    ).toBe("tmux");
  });

  test("returns iterm when TERM_PROGRAM is iTerm.app", () => {
    expect(_detectNotifier({ TERM_PROGRAM: "iTerm.app" }, "darwin")).toBe(
      "iterm",
    );
  });

  test("returns apple-terminal when TERM_PROGRAM is Apple_Terminal", () => {
    expect(_detectNotifier({ TERM_PROGRAM: "Apple_Terminal" }, "darwin")).toBe(
      "apple-terminal",
    );
  });

  test("returns osascript as fallback on darwin", () => {
    expect(_detectNotifier({}, "darwin")).toBe("osascript");
  });

  test("CMUX_SOCKET_PATH takes priority over TMUX", () => {
    expect(
      _detectNotifier(
        {
          CMUX_SOCKET_PATH: "/tmp/cmux.sock",
          TMUX: "/tmp/tmux",
        },
        "darwin",
      ),
    ).toBe("cmux");
  });

  test("TMUX takes priority over TERM_PROGRAM", () => {
    expect(
      _detectNotifier(
        { TMUX: "/tmp/tmux", TERM_PROGRAM: "iTerm.app" },
        "darwin",
      ),
    ).toBe("tmux");
  });

  test("ignores terminal env vars on linux", () => {
    expect(
      _detectNotifier(
        { TERM_PROGRAM: "iTerm.app", TMUX: "/tmp/tmux" },
        "linux",
      ),
    ).toBe("notify-send");
  });
});

describe("sanitizeOscPayload", () => {
  test("strips BEL character", () => {
    expect(_sanitizeOscPayload("hello\x07world")).toBe("helloworld");
  });

  test("strips ESC character", () => {
    expect(_sanitizeOscPayload("hello\x1bworld")).toBe("helloworld");
  });

  test("strips ST character", () => {
    expect(_sanitizeOscPayload("hello\x9cworld")).toBe("helloworld");
  });

  test("strips semicolons", () => {
    expect(_sanitizeOscPayload("hello;world")).toBe("helloworld");
  });

  test("leaves normal text unchanged", () => {
    expect(_sanitizeOscPayload("Hello World 123!")).toBe("Hello World 123!");
  });

  test("strips multiple special characters at once", () => {
    expect(_sanitizeOscPayload("a\x07b\x1bc\x9cd;e")).toBe("abcde");
  });
});

describe("findTmuxOuterTerminal", () => {
  test("finds iTerm in ancestor chain", async () => {
    const run = vi.fn<ExecRunnerFn>();
    run.mockResolvedValueOnce("1234\n"); // tmux display-message
    run.mockResolvedValueOnce("1233 bash\n"); // ps for 1234
    run.mockResolvedValueOnce("1232 iTerm2\n"); // ps for 1233
    expect(await _findTmuxOuterTerminal(run)).toBe("iterm");
  });

  test("finds cmux in ancestor chain", async () => {
    const run = vi.fn<ExecRunnerFn>();
    run.mockResolvedValueOnce("1234\n");
    run.mockResolvedValueOnce("1233 cmux\n");
    expect(await _findTmuxOuterTerminal(run)).toBe("cmux");
  });

  test("finds Apple Terminal in ancestor chain", async () => {
    const run = vi.fn<ExecRunnerFn>();
    run.mockResolvedValueOnce("1234\n");
    run.mockResolvedValueOnce("1233 Terminal\n");
    expect(await _findTmuxOuterTerminal(run)).toBe("apple-terminal");
  });

  test("returns undefined when PID 1 is reached", async () => {
    const run = vi.fn<ExecRunnerFn>();
    run.mockResolvedValueOnce("1234\n");
    run.mockResolvedValueOnce("1 bash\n");
    expect(await _findTmuxOuterTerminal(run)).toBeUndefined();
  });

  test("returns undefined when tmux display-message fails", async () => {
    const run = vi.fn<ExecRunnerFn>();
    run.mockRejectedValue(new Error("not connected"));
    expect(await _findTmuxOuterTerminal(run)).toBeUndefined();
  });

  test("returns undefined when max depth reached", async () => {
    const run = vi.fn<ExecRunnerFn>();
    run.mockResolvedValueOnce("1000\n"); // tmux display-message
    for (let i = 0; i < 5; i++) {
      run.mockResolvedValueOnce(`${999 - i} bash\n`);
    }
    expect(await _findTmuxOuterTerminal(run)).toBeUndefined();
  });

  test("returns undefined for empty client pid", async () => {
    const run = vi.fn<ExecRunnerFn>();
    run.mockResolvedValueOnce("\n");
    expect(await _findTmuxOuterTerminal(run)).toBeUndefined();
  });

  test("returns undefined for client pid 0", async () => {
    const run = vi.fn<ExecRunnerFn>();
    run.mockResolvedValueOnce("0\n");
    expect(await _findTmuxOuterTerminal(run)).toBeUndefined();
  });
});

describe("probeTmuxPassthrough", () => {
  test("returns true for 'on'", async () => {
    const run = vi.fn<ExecRunnerFn>();
    run.mockResolvedValueOnce("on\n");
    expect(await _probeTmuxPassthrough(run)).toBe(true);
  });

  test("returns true for 'all'", async () => {
    const run = vi.fn<ExecRunnerFn>();
    run.mockResolvedValueOnce("all\n");
    expect(await _probeTmuxPassthrough(run)).toBe(true);
  });

  test("returns false for 'off'", async () => {
    const run = vi.fn<ExecRunnerFn>();
    run.mockResolvedValueOnce("off\n");
    expect(await _probeTmuxPassthrough(run)).toBe(false);
  });

  test("returns false for empty value", async () => {
    const run = vi.fn<ExecRunnerFn>();
    run.mockResolvedValueOnce("\n");
    expect(await _probeTmuxPassthrough(run)).toBe(false);
  });

  test("returns false on error", async () => {
    const run = vi.fn<ExecRunnerFn>();
    run.mockRejectedValue(new Error("no tmux"));
    expect(await _probeTmuxPassthrough(run)).toBe(false);
  });
});

describe("desktop notification dispatch", () => {
  let stdoutWriteSpy: MockInstance;
  let originalPlatform: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.mocked(execFile).mockReset();
    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
    });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  test("cmux: calls cmux notify CLI", async () => {
    process.env.CMUX_SOCKET_PATH = "/tmp/cmux.sock";
    const run = vi.fn<ExecRunnerFn>();
    run.mockResolvedValueOnce("");
    await _sendDesktop("Hello", run);
    expect(run).toHaveBeenCalledWith("cmux", [
      "notify",
      "--title",
      "agentcoop",
      "--body",
      "Hello",
    ]);
  });

  test("cmux: falls back to OSC 777 when CLI unavailable", async () => {
    process.env.CMUX_SOCKET_PATH = "/tmp/cmux.sock";
    const run = vi.fn<ExecRunnerFn>();
    run.mockRejectedValueOnce(new Error("command not found"));
    await _sendDesktop("Hello", run);
    expect(stdoutWriteSpy).toHaveBeenCalledWith(
      "\x1b]777;notify;agentcoop;Hello\x07",
    );
  });

  test("iterm: sends OSC 9 escape sequence", async () => {
    process.env.TERM_PROGRAM = "iTerm.app";
    await _sendDesktop("Hello");
    expect(stdoutWriteSpy).toHaveBeenCalledWith("\x1b]9;Hello\x07");
    expect(execFile).not.toHaveBeenCalled();
  });

  test("iterm: sanitizes OSC 9 payload", async () => {
    process.env.TERM_PROGRAM = "iTerm.app";
    await _sendDesktop("Hello\x07World");
    expect(stdoutWriteSpy).toHaveBeenCalledWith("\x1b]9;HelloWorld\x07");
  });

  test("tmux+iterm: sends DCS-wrapped OSC 9 when passthrough enabled", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    const run = vi.fn<ExecRunnerFn>();
    run
      .mockResolvedValueOnce("5678\n") // tmux display-message
      .mockResolvedValueOnce("5677 iTerm2\n") // ps — found iTerm
      .mockResolvedValueOnce("on\n"); // tmux show allow-passthrough
    await _sendDesktop("Hello", run);
    expect(stdoutWriteSpy).toHaveBeenCalledWith(
      "\x1bPtmux;\x1b\x1b]9;Hello\x07\x1b\\",
    );
  });

  test("tmux+iterm: falls back to osascript when passthrough disabled", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    const run = vi.fn<ExecRunnerFn>();
    run
      .mockResolvedValueOnce("5678\n") // tmux display-message
      .mockResolvedValueOnce("5677 iTerm2\n") // ps
      .mockResolvedValueOnce("off\n"); // tmux show allow-passthrough
    await _sendDesktop("Hello", run);
    expect(execFile).toHaveBeenCalledWith("osascript", [
      "-e",
      'display notification "Hello" with title "agentcoop"',
    ]);
  });

  test("tmux+unknown: falls back to osascript", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    const run = vi.fn<ExecRunnerFn>();
    run.mockResolvedValueOnce("5678\n").mockResolvedValueOnce("1 bash\n"); // ppid is 1
    await _sendDesktop("Hello", run);
    expect(execFile).toHaveBeenCalledWith("osascript", [
      "-e",
      'display notification "Hello" with title "agentcoop"',
    ]);
  });

  test("tmux+cmux: calls cmux notify CLI", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    const run = vi.fn<ExecRunnerFn>();
    run
      .mockResolvedValueOnce("5678\n") // tmux display-message
      .mockResolvedValueOnce("5677 cmux\n") // ps — found cmux
      .mockResolvedValueOnce(""); // cmux notify CLI
    await _sendDesktop("Hello", run);
    expect(run).toHaveBeenCalledWith("cmux", [
      "notify",
      "--title",
      "agentcoop",
      "--body",
      "Hello",
    ]);
  });

  test("tmux+apple-terminal: falls back to osascript", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    const run = vi.fn<ExecRunnerFn>();
    run
      .mockResolvedValueOnce("5678\n") // tmux display-message
      .mockResolvedValueOnce("5677 Terminal\n"); // ps — found Apple Terminal
    await _sendDesktop("Hello", run);
    expect(execFile).toHaveBeenCalledWith("osascript", [
      "-e",
      'display notification "Hello" with title "agentcoop"',
    ]);
  });

  test("tmux display-message failure: falls back to osascript", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    const run = vi.fn<ExecRunnerFn>();
    run.mockRejectedValue(new Error("no clients"));
    await _sendDesktop("Hello", run);
    expect(execFile).toHaveBeenCalledWith("osascript", [
      "-e",
      'display notification "Hello" with title "agentcoop"',
    ]);
  });

  test("iterm: silently handles stdout.write failure", async () => {
    process.env.TERM_PROGRAM = "iTerm.app";
    stdoutWriteSpy.mockImplementation(() => {
      throw new Error("stdout broken");
    });
    // Should not reject — outer try/catch swallows.
    await _sendDesktop("Hello");
  });
});

type ExecRunnerFn = (cmd: string, args: readonly string[]) => Promise<string>;
