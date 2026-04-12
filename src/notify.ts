import { execFile } from "node:child_process";
import type { NotificationSettings } from "./config.js";
import { t } from "./i18n/index.js";

/**
 * Send notifications to alert the user that the pipeline is waiting
 * for input.  Fires bell and/or desktop notification based on settings.
 * All errors are silently swallowed — notifications must never block
 * or break the prompt flow.
 */
export function notifyInputWaiting(
  settings: NotificationSettings,
  message: string,
): void {
  if (settings.bell) {
    emitBell();
  }
  if (settings.desktop) {
    sendDesktopNotification(message).catch(() => {});
  }
}

/** Emit the BEL character (\x07) to stdout. */
function emitBell(): void {
  try {
    process.stdout.write("\x07");
  } catch {
    // Ignore — stdout may be closed or not writable.
  }
}

type Notifier =
  | "cmux"
  | "tmux"
  | "iterm"
  | "apple-terminal"
  | "osascript"
  | "notify-send"
  | "none";

/** Async shell runner used by tmux helpers and cmux CLI. */
type ExecRunner = (cmd: string, args: readonly string[]) => Promise<string>;

function defaultExecRunner(
  cmd: string,
  args: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      [...args],
      { encoding: "utf8", timeout: 5000 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/**
 * Detect the appropriate notifier based on environment variables and
 * platform.  Returns an intermediate "tmux" value when further
 * process-tree resolution is needed.
 */
function detectNotifier(
  env: Record<string, string | undefined>,
  platform: string = process.platform,
): Notifier {
  if (platform === "linux") return "notify-send";
  if (platform !== "darwin") return "none";
  if (env.CMUX_SOCKET_PATH) return "cmux";
  if (env.TMUX) return "tmux";
  if (env.TERM_PROGRAM === "iTerm.app") return "iterm";
  if (env.TERM_PROGRAM === "Apple_Terminal") return "apple-terminal";
  return "osascript";
}

/**
 * Sanitize text for embedding in OSC escape sequences.
 * Strips BEL, ESC, ST, and semicolons to prevent sequence
 * truncation or misparsing.
 */
function sanitizeOscPayload(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal control chars is the purpose of this function
  return text.replace(/[\x07\x1b\x9c;]/g, "");
}

/**
 * Walk the tmux process tree from the attached client upward
 * (max 5 levels) to identify the outer terminal emulator.
 */
async function findTmuxOuterTerminal(
  run: ExecRunner = defaultExecRunner,
): Promise<"cmux" | "iterm" | "apple-terminal" | undefined> {
  try {
    const clientPid = (
      await run("tmux", ["display-message", "-p", "#{client_pid}"])
    ).trim();
    if (!clientPid || clientPid === "0") return undefined;

    let pid = clientPid;
    for (let i = 0; i < 5; i++) {
      const line = (await run("ps", ["-p", pid, "-o", "ppid=,comm="])).trim();
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) return undefined;

      const ppid = match[1];
      const name = (match[2].split("/").pop() ?? "").trim();

      if (/cmux/i.test(name)) return "cmux";
      if (/iterm/i.test(name)) return "iterm";
      if (name === "Terminal") return "apple-terminal";

      if (ppid === "0" || ppid === "1" || ppid === pid) return undefined;
      pid = ppid;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Probe the tmux `allow-passthrough` global setting.
 * Returns true if passthrough is enabled ("on" or "all").
 */
async function probeTmuxPassthrough(
  run: ExecRunner = defaultExecRunner,
): Promise<boolean> {
  try {
    const value = (
      await run("tmux", ["show", "-gv", "allow-passthrough"])
    ).trim();
    return value === "on" || value === "all";
  } catch {
    return false;
  }
}

/** Send a desktop notification using platform-native commands. */
async function sendDesktopNotification(
  message: string,
  run: ExecRunner = defaultExecRunner,
): Promise<void> {
  try {
    const title = t()["notification.title"];
    let notifier = detectNotifier(process.env);

    if (notifier === "none") return;

    if (notifier === "notify-send") {
      execFile("notify-send", [title, message]);
      return;
    }

    // macOS — resolve tmux to a concrete notifier
    if (notifier === "tmux") {
      const outer = await findTmuxOuterTerminal(run);
      if (outer === "cmux") {
        notifier = "cmux";
      } else if (outer === "iterm") {
        if (await probeTmuxPassthrough(run)) {
          const sanitized = sanitizeOscPayload(message);
          process.stdout.write(`\x1bPtmux;\x1b\x1b]9;${sanitized}\x07\x1b\\`);
          return;
        }
        notifier = "osascript";
      } else {
        notifier = "osascript";
      }
    }

    switch (notifier) {
      case "cmux": {
        try {
          await run("cmux", ["notify", "--title", title, "--body", message]);
        } catch {
          // Binary unavailable — fall back to OSC 777
          const oscTitle = sanitizeOscPayload(title);
          const oscBody = sanitizeOscPayload(message);
          process.stdout.write(`\x1b]777;notify;${oscTitle};${oscBody}\x07`);
        }
        break;
      }
      case "iterm":
        process.stdout.write(`\x1b]9;${sanitizeOscPayload(message)}\x07`);
        break;
      case "apple-terminal":
      case "osascript":
        execFile("osascript", [
          "-e",
          `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`,
        ]);
        break;
    }
  } catch {
    // Silently ignore — command may not exist, no GUI session, etc.
  }
}

/** Escape double quotes and backslashes for AppleScript string literals. */
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export {
  detectNotifier as _detectNotifier,
  emitBell as _emitBell,
  findTmuxOuterTerminal as _findTmuxOuterTerminal,
  probeTmuxPassthrough as _probeTmuxPassthrough,
  sanitizeOscPayload as _sanitizeOscPayload,
  sendDesktopNotification as _sendDesktop,
};
