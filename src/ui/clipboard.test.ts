import { describe, expect, test, vi } from "vitest";
import {
  type ClipboardCandidate,
  type ClipboardEnvironment,
  detectClipboardSupport,
  encodeOsc52,
  writeToClipboard,
} from "./clipboard.js";

function makeEnv(
  overrides: Partial<ClipboardEnvironment> = {},
): ClipboardEnvironment {
  return {
    platform: "linux",
    env: {},
    stdoutIsTTY: true,
    hasCommand: () => false,
    ...overrides,
  };
}

describe("encodeOsc52", () => {
  test("emits ESC]52;c;<base64> BEL", () => {
    const encoded = encodeOsc52("hello");
    expect(encoded).toBe(
      `\x1b]52;c;${Buffer.from("hello", "utf8").toString("base64")}\x07`,
    );
  });

  test("base64-encodes multibyte UTF-8 faithfully", () => {
    const value = "타이틀 🟢";
    const encoded = encodeOsc52(value);
    const payload = encoded.slice("\x1b]52;c;".length, -"\x07".length);
    expect(Buffer.from(payload, "base64").toString("utf8")).toBe(value);
  });
});

describe("detectClipboardSupport", () => {
  test("macOS: prefers pbcopy over osc52", () => {
    const candidates = detectClipboardSupport(
      makeEnv({
        platform: "darwin",
        hasCommand: (cmd) => cmd === "pbcopy",
      }),
    );
    expect(candidates).toEqual(["pbcopy", "osc52"]);
  });

  test("macOS: pbcopy is unconditional even when PATH does not list it", () => {
    // `pbcopy` ships with macOS; a stripped PATH must not hide it.
    const candidates = detectClipboardSupport(
      makeEnv({
        platform: "darwin",
        hasCommand: () => false,
      }),
    );
    expect(candidates).toEqual(["pbcopy", "osc52"]);
  });

  test("macOS without stdout TTY: pbcopy still enqueued", () => {
    // Even with stdout redirected to a file (no OSC 52 path), the
    // deterministic native candidate must remain available.
    const candidates = detectClipboardSupport(
      makeEnv({
        platform: "darwin",
        stdoutIsTTY: false,
        hasCommand: () => false,
      }),
    );
    expect(candidates).toEqual(["pbcopy"]);
  });

  test("linux + Wayland: wl-copy wins", () => {
    const candidates = detectClipboardSupport(
      makeEnv({
        platform: "linux",
        env: { WAYLAND_DISPLAY: "wayland-0" },
        hasCommand: (cmd) => cmd === "wl-copy",
      }),
    );
    expect(candidates).toEqual(["wl-copy", "osc52"]);
  });

  test("linux + X11: xclip wins", () => {
    const candidates = detectClipboardSupport(
      makeEnv({
        platform: "linux",
        env: { DISPLAY: ":0" },
        hasCommand: (cmd) => cmd === "xclip",
      }),
    );
    expect(candidates).toEqual(["xclip", "osc52"]);
  });

  test("SSH session: osc52 first, native tool (if present) last", () => {
    const candidates = detectClipboardSupport(
      makeEnv({
        platform: "darwin",
        env: { SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 55000" },
        hasCommand: (cmd) => cmd === "pbcopy",
      }),
    );
    expect(candidates).toEqual(["osc52", "pbcopy"]);
  });

  test("SSH without native tool: osc52 only", () => {
    const candidates = detectClipboardSupport(
      makeEnv({
        platform: "linux",
        env: { SSH_TTY: "/dev/pts/0" },
      }),
    );
    expect(candidates).toEqual(["osc52"]);
  });

  test("no TTY and no native tool: empty list", () => {
    const candidates = detectClipboardSupport(
      makeEnv({
        platform: "linux",
        stdoutIsTTY: false,
      }),
    );
    expect(candidates).toEqual([]);
  });

  test("linux without DISPLAY/WAYLAND: falls through to osc52", () => {
    const candidates = detectClipboardSupport(
      makeEnv({
        platform: "linux",
        hasCommand: (cmd) => cmd === "xclip" || cmd === "wl-copy",
      }),
    );
    expect(candidates).toEqual(["osc52"]);
  });
});

describe("writeToClipboard", () => {
  test("first candidate succeeds → reports ok, later candidates skipped", async () => {
    const spawnSync = vi
      .fn()
      .mockReturnValue({ status: 0, stdout: "", stderr: "" });
    const stdoutWrite = vi.fn().mockReturnValue(true);
    const result = await writeToClipboard("hello", ["pbcopy", "osc52"], {
      spawnSync,
      stdoutWrite,
    });
    expect(result).toBe("ok");
    expect(spawnSync).toHaveBeenCalledOnce();
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  test("first candidate fails, second succeeds", async () => {
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "bad" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    const result = await writeToClipboard("hello", ["wl-copy", "xclip"], {
      spawnSync,
      stdoutWrite: vi.fn(),
    });
    expect(result).toBe("ok");
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  test("osc52 write that throws falls through to next candidate", async () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0 });
    const stdoutWrite = vi.fn().mockImplementation(() => {
      throw new Error("broken pipe");
    });
    const result = await writeToClipboard("hello", ["osc52", "pbcopy"], {
      spawnSync,
      stdoutWrite,
    });
    expect(result).toBe("ok");
    expect(stdoutWrite).toHaveBeenCalledOnce();
    expect(spawnSync).toHaveBeenCalledOnce();
  });

  test("all candidates fail → error", async () => {
    const spawnSync = vi
      .fn()
      .mockReturnValue({ status: 1, stdout: "", stderr: "bad" });
    const stdoutWrite = vi.fn().mockImplementation(() => {
      throw new Error("nope");
    });
    const result = await writeToClipboard("hello", ["pbcopy", "osc52"], {
      spawnSync,
      stdoutWrite,
    });
    expect(result).toBe("error");
  });

  test("native spawn error skips candidate", async () => {
    const spawnSync = vi.fn().mockReturnValue({
      error: new Error("ENOENT"),
      status: null,
      stdout: "",
      stderr: "",
    });
    const stdoutWrite = vi.fn().mockReturnValue(true);
    const result = await writeToClipboard(
      "hello",
      ["pbcopy", "osc52"] as ClipboardCandidate[],
      { spawnSync, stdoutWrite },
    );
    expect(result).toBe("ok");
    expect(stdoutWrite).toHaveBeenCalledOnce();
  });

  test("empty candidate list → error", async () => {
    const result = await writeToClipboard("hello", [], {
      spawnSync: vi.fn(),
      stdoutWrite: vi.fn(),
    });
    expect(result).toBe("error");
  });

  test("osc52 writes correct base64 payload to stdout", async () => {
    const stdoutWrite = vi.fn().mockReturnValue(true);
    await writeToClipboard("hello world", ["osc52"], {
      spawnSync: vi.fn(),
      stdoutWrite,
    });
    expect(stdoutWrite).toHaveBeenCalledWith(encodeOsc52("hello world"));
  });

  test("native write receives value via stdin", async () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0 });
    await writeToClipboard("suggested commit title", ["pbcopy"], {
      spawnSync,
      stdoutWrite: vi.fn(),
    });
    expect(spawnSync).toHaveBeenCalledWith(
      "/usr/bin/pbcopy",
      [],
      expect.objectContaining({ input: "suggested commit title" }),
    );
  });

  test("pbcopy invocation uses absolute /usr/bin path (bypasses PATH)", async () => {
    // `detectClipboardSupport` enqueues `pbcopy` unconditionally on
    // darwin; the writer must invoke the absolute path so a stripped
    // PATH (e.g. PATH missing `/usr/bin`) still reaches the binary.
    const spawnSync = vi.fn().mockReturnValue({ status: 0 });
    const result = await writeToClipboard("v", ["pbcopy"], {
      spawnSync,
      stdoutWrite: vi.fn(),
    });
    expect(result).toBe("ok");
    expect(spawnSync).toHaveBeenCalledWith(
      "/usr/bin/pbcopy",
      [],
      expect.any(Object),
    );
    expect(spawnSync).not.toHaveBeenCalledWith(
      "pbcopy",
      expect.anything(),
      expect.anything(),
    );
  });

  test("xclip invocation uses -selection clipboard", async () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0 });
    await writeToClipboard("v", ["xclip"], {
      spawnSync,
      stdoutWrite: vi.fn(),
    });
    expect(spawnSync).toHaveBeenCalledWith(
      "xclip",
      ["-selection", "clipboard"],
      expect.any(Object),
    );
  });
});
